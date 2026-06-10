require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

// ============================================================================
// 1. MIDDLEWARE & SERVER CONFIG
// ============================================================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-admin-pass');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/health', (req, res) => {
    res.json({ status: 'Online', db_state: mongoose.connection.readyState });
});

// ============================================================================
// 2. MONGODB CONNECTION & SCHEMAS
// ============================================================================
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/stickntrade', {
    serverSelectionTimeoutMS: 5000 
}).then(() => {
    console.log('MongoDB Connected Successfully');
}).catch(err => console.error('MongoDB connection error:', err.message));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true }, 
    password: { type: String, required: true },
    credits: { type: Number, default: 0 }, 
    status: { type: String, default: 'pending' }, // 'pending', 'active', 'banned'
    role: { type: String, default: 'player' }, // 'player', 'vip', 'team', 'admin'
    nameColor: { type: String, default: '#f8fafc' }, 
    ipAddress: String, 
    tosAccepted: Boolean, 
    lastRewardClaim: { type: Date, default: null }, 
    createdAt: { type: Date, default: Date.now },
    inventory: { type: [String], default: [] } 
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    username: String, 
    type: String, 
    amount: Number, 
    status: { type: String, default: 'completed' }, 
    date: { type: Date, default: Date.now }
}));

const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    username: String, 
    target: String, 
    type: String, 
    subject: String,
    messages: [{ sender: String, text: String, date: { type: Date, default: Date.now } }],
    status: { type: String, default: 'open' }, 
    unreadPlayer: { type: Boolean, default: true },
    unreadAdmin: { type: Boolean, default: false }, 
    readBy: { type: [String], default: [] }, 
    updatedAt: { type: Date, default: Date.now }
}));

const GameRound = mongoose.model('GameRound', new mongoose.Schema({
    game: String, 
    roundId: String, 
    timestamp: { type: Date, default: Date.now },
    result: mongoose.Schema.Types.Mixed, 
    players: [{ username: String, choice: String, bet: Number, win: Number }]
}));

// ============================================================================
// 3. GAME STATE GLOBALS & INITIALIZATION
// ============================================================================
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']; 
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createRoom(numSeats) {
    return { 
        seats: Array(numSeats).fill(null), dealerCards: [], deck: [], 
        status: 'waiting', activeSeatIndex: -1, betEndTime: 0, nextRoundTime: 0, turnEndTime: 0, 
        lobby: [], betTimerInterval: null, nextRoundInterval: null, turnTimerInterval: null, dealerInterval: null 
    };
}

const rooms = { '3seat': createRoom(3), '5seat': createRoom(5) };
function getGameTitle(roomId) { return roomId === '5seat' ? 'CLASSIC BLACKJACK' : 'VIP BLACKJACK'; }

const diceGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: [1, 1], bets: [], history: [] };
const derbyGame = { status: 'betting', betEndTime: Date.now() + 15000, distances: [0,0,0,0], bets: [], history: [] };
const DERBY_ODDS = 2.5; 

const PERYA_COLORS = ['red', 'blue', 'yellow', 'green', 'pink', 'white'];
const colorGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: ['red', 'blue', 'yellow'], bets: [], history: [] };
const cupsGame = { status: 'shuffling', stateEndTime: Date.now() + 3000, betEndTime: 0, winningCup: 0, bets: [], history: [] };
const baccaratGame = { status: 'betting', betEndTime: Date.now() + 15000, pCards: [], bCards: [], pVal: 0, bVal: 0, winner: '', bets: [], history: [] };
const dvtGame = { status: 'betting', betEndTime: Date.now() + 12000, dragonCard: null, tigerCard: null, winner: '', bets: [], history: [] };

let pvpDuel = { seats: [null, null], status: 'waiting', type: 'coin', format: 1, betAmount: 0, slices: 4, hostIndex: -1, result: null, winSliceIndex: 0, message: 'WAITING FOR PLAYERS', timerInterval: null };

let activeAuctions = []; let liveTradeOffers = []; let activeTradeSessions = {};
const socketUserMap = {}; 
let diceLobby = []; let derbyLobby = []; let colorLobby = []; let pvpLobby = []; let cupsLobby = []; let baccaratLobby = []; let dvtLobby = []; let slotsLobby = [];

let gameLocks = { blackjack: false, dice: false, derby: false, color: false, cups: false, baccarat: false, dvt: false, slots: false };

function getPHTTime() { try { return new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila' }); } catch(e) { return new Date().toLocaleTimeString(); } }
function adminLog(action) { io.to('admin_room').emit('admin_log', `▶ [${getPHTTime()}] ${action}`); }

function getNewDeck() { 
    let deck = []; 
    for (let i = 0; i < 6; i++) { 
        for (let s of suits) { 
            for (let v of values) { 
                deck.push({ suit: s, value: v, weight: ['J','Q','K'].includes(v) ? 10 : (v === 'A' ? 11 : parseInt(v)) }); 
            } 
        } 
    } 
    return deck.sort(() => Math.random() - 0.5); 
}

const getBaccaratWeight = c => { if(!c) return 0; if(c.value === 'A') return 1; if(['J','Q','K','10'].includes(c.value)) return 0; return parseInt(c.value) || 0; };
const getDvtWeight = c => { if(!c) return 0; if(c.value === 'A') return 1; if(c.value === 'J') return 11; if(c.value === 'Q') return 12; if(c.value === 'K') return 13; return parseInt(c.value); };

// ============================================================================
// 4. REST APIs (PLAYER & ADMIN ROUTES)
// ============================================================================
app.post('/api/signup', async (req, res) => { 
    try { 
        if (mongoose.connection.readyState !== 1) return res.status(500).json({ error: 'DATABASE DISCONNECTED.' }); 
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        
        const existing = await User.findOne({ username: new RegExp('^' + req.body.username + '$', 'i') }); 
        if(existing) return res.status(400).json({ error: 'Username already taken.' });
        
        await new User({ 
            username: req.body.username, 
            password: req.body.password, 
            ipAddress: ip, 
            tosAccepted: true, 
            status: 'pending', 
            role: 'player',
            inventory: [] 
        }).save(); 
        
        adminLog(`New account requested: ${req.body.username}`); 
        res.status(201).json({ message: 'Account requested successfully.' }); 
    } catch (err) { res.status(400).json({ error: 'Database error.' }); } 
});

app.post('/api/login', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) return res.status(500).json({ error: 'DATABASE DISCONNECTED.' }); 
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({error: "Missing credentials"});

        let user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });

        if (!user) return res.status(401).json({ error: 'Account not found. Please sign up.' });
        if (user.password !== password) return res.status(401).json({ error: 'Invalid password.' });
        
        if (user.status === 'pending') return res.status(401).json({ error: 'Account pending Admin approval.' });
        if (user.status === 'banned') return res.status(401).json({ error: 'Account banned.' });
        
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; 
        user.ipAddress = ip; 
        await user.save();
        adminLog(`${user.username} logged in.`);
        res.json({ username: user.username, credits: user.credits, status: user.status, inventory: user.inventory, role: user.role });
    } catch(e) { res.status(500).json({ error: 'Server error during login.' }); }
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const sysAdminPw = process.env.ADMIN_PASSWORD || 'admin123';
    const sysModPw = process.env.MOD_PASSWORD || 'mod123';

    if (password === sysAdminPw) return res.json({ success: true, role: 'admin' });
    if (password === sysModPw) return res.json({ success: true, role: 'mod' });
    return res.status(401).json({ error: 'Unauthorized.' });
});

app.post('/api/bank/request', async (req, res) => {
    try {
        const { username, type, amount } = req.body; 
        let txType = type === 'deposit' ? 'BANK DEPOSIT' : 'BANK WITHDRAWAL'; 
        let currentCredits = undefined;
        
        if (amount <= 0 || amount > 100000) return res.status(400).json({ error: 'Invalid Limit. Max is 100,000.' });

        if (type === 'withdrawal') {
            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return res.status(400).json({ error: 'Insufficient funds.' }); 
            currentCredits = user.credits;
        } else if (type === 'deposit') {
            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i') }, { $inc: { credits: amount } }, { new: true });
            if (!user) return res.status(400).json({ error: 'User not found.' }); 
            currentCredits = user.credits;
        }
        await new Transaction({ username, type: txType, amount, status: 'completed' }).save(); 
        res.json({ success: true, newCredits: currentCredits });
    } catch(e) { res.status(500).json({ error: 'Server Error' }); }
});

// ============================================================================
// 5. BLACKJACK ENGINE
// ============================================================================
function calculateValue(cards) { 
    let val = 0; let aces = 0; 
    cards.forEach(c => { val += c.weight; if (c.value === 'A') aces++; }); 
    while (val > 21 && aces > 0) { val -= 10; aces--; } 
    return val; 
}

function startGame(roomId) {
    try {
        let room = rooms[roomId]; if (!room) return; 
        room.status = 'playing'; room.deck = getNewDeck(); room.dealerCards = []; 
        room.seats = room.seats.map(s => (s && s.hands[0].bet === 0) ? null : s);
        
        for (let i = 0; i < 2; i++) { 
            room.seats.forEach(seat => { if (seat) seat.hands[0].cards.push(room.deck.pop()); }); 
            room.dealerCards.push(room.deck.pop()); 
        }
        
        room.seats.forEach(seat => { 
            if (seat) { 
                seat.hands[0].value = calculateValue(seat.hands[0].cards); 
                if (seat.hands[0].value === 21) seat.hands[0].status = 'blackjack'; 
            }
        });
        
        let dealerInitialValue = calculateValue(room.dealerCards); 
        if (dealerInitialValue === 21) { 
            room.dealerCards[1].hidden = false; resolveBets(roomId, 21); return; 
        }
        
        room.activeSeatIndex = room.seats.findIndex(s => s && s.hands[0].status === 'waiting');
        if (room.activeSeatIndex === -1) { processDealerTurn(roomId); } 
        else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); }
    } catch(e) { console.error("Blackjack Start Error:", e); }
}

function moveToNextTurn(roomId) {
    try {
        let room = rooms[roomId]; if (!room) return; 
        clearInterval(room.turnTimerInterval);  const seat = room.seats[room.activeSeatIndex];
        
        if (seat && seat.currentHand < seat.hands.length - 1) { 
            seat.currentHand++; 
            if (seat.hands[seat.currentHand].status !== 'waiting') return moveToNextTurn(roomId); 
            room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); return; 
        }
        
        let nextIndex = room.activeSeatIndex + 1; 
        while (nextIndex < room.seats.length) { 
            if (room.seats[nextIndex] && room.seats[nextIndex].hands[0].status === 'waiting') break; 
            nextIndex++; 
        }
        
        if (nextIndex >= room.seats.length) { processDealerTurn(roomId); } 
        else { room.activeSeatIndex = nextIndex; room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); }
    } catch(e) { console.error("Blackjack Turn Error:", e); }
}

async function processDealerTurn(roomId) {
    try {
        let room = rooms[roomId]; if (!room) return; 
        room.status = 'dealerTurn'; room.activeSeatIndex = -1; clearInterval(room.turnTimerInterval);
        
        setTimeout(() => {
            if(room.dealerCards.length > 1) room.dealerCards[1].hidden = false; 
            emitGameState(roomId);
            
            setTimeout(() => {
                let dealerValue = calculateValue(room.dealerCards); 
                if (dealerValue >= 17) { resolveBets(roomId, dealerValue); return; }
                
                room.dealerInterval = setInterval(() => { 
                    if (dealerValue < 17) { 
                        room.dealerCards.push(room.deck.pop()); 
                        dealerValue = calculateValue(room.dealerCards); 
                        emitGameState(roomId); 
                    } else { 
                        clearInterval(room.dealerInterval); 
                        resolveBets(roomId, dealerValue); 
                    } 
                }, 1000);
            }, 1000); 
        }, 1500);
    } catch(e) { console.error("Blackjack Dealer Error:", e); }
}

async function resolveBets(roomId, dealerValue) {
    try {
        let room = rooms[roomId]; if (!room) return; 
        room.status = 'resolving'; room.nextRoundTime = Date.now() + 7000; 
        
        for (const seat of room.seats) {
            if (seat) {
                for (const hand of seat.hands) {
                    if (hand.bet > 0) {
                        let payout = 0;
                        if (hand.status === 'blackjack' && dealerValue !== 21) { payout = hand.bet * 2.5; hand.result = 'win-bj'; } 
                        else if (hand.status !== 'bust' && (dealerValue > 21 || hand.value > dealerValue)) { payout = hand.bet * 2; hand.result = 'win'; } 
                        else if (hand.status !== 'bust' && hand.value === dealerValue) { payout = hand.bet; hand.result = 'push'; } 
                        else if (hand.status === 'bust') { hand.result = 'bust'; } 
                        else { hand.result = 'lose'; }
                        
                        if (payout > 0) { 
                            seat.credits += payout; 
                            try {
                                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i') }, { $inc: { credits: payout } }, { new: true }); 
                                if(updatedUser) { 
                                    await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId) + " WIN", amount: payout }).save(); 
                                    io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                                }
                            } catch(e) {}
                        }
                    }
                }
            }
        }
        
        emitGameState(roomId); clearInterval(room.nextRoundInterval);
        room.nextRoundInterval = setInterval(() => {
            if (Date.now() >= room.nextRoundTime) {
                clearInterval(room.nextRoundInterval); room.dealerCards = [];
                room.seats.forEach(seat => { 
                    if(seat) { seat.hands = [{ cards: [], bet: 0, status: 'waiting', value: 0 }]; seat.currentHand = 0; seat.kickAt = Date.now() + 15000; } 
                });
                const anyoneSeated = room.seats.some(s => s !== null); 
                room.status = anyoneSeated ? 'betting' : 'waiting'; 
                emitGameState(roomId);
            }
        }, 1000);
    } catch(e) { console.error("Blackjack Resolve Error:", e); }
}

function emitGameState(roomId) {
    let room = rooms[roomId]; if (!room) return;
    const { betTimerInterval, nextRoundInterval, turnTimerInterval, dealerInterval, ...serializableRoom } = room;
    let safeState = JSON.parse(JSON.stringify(serializableRoom)); const now = Date.now();
    
    safeState.seats.forEach(s => { if (s && s.kickAt) s.kickTimeLeft = Math.max(0, s.kickAt - now); });
    if (safeState.betEndTime) safeState.betTimeLeft = Math.max(0, safeState.betEndTime - now);
    if (safeState.nextRoundTime) safeState.nextRoundTimeLeft = Math.max(0, safeState.nextRoundTime - now);
    if (safeState.turnEndTime) safeState.turnTimeLeft = Math.max(0, safeState.turnEndTime - now);
    
    if (safeState.status === 'playing' && safeState.dealerCards.length > 1) safeState.dealerCards[1] = { hidden: true };
    io.to(roomId).emit('game_state_update', safeState);
}

function startTurnTimer(roomId) {
    let room = rooms[roomId]; clearInterval(room.turnTimerInterval);
    room.turnTimerInterval = setInterval(() => { 
        if (Date.now() >= room.turnEndTime) { 
            clearInterval(room.turnTimerInterval); 
            let seat = room.seats[room.activeSeatIndex]; 
            if (seat && seat.hands[seat.currentHand]) seat.hands[seat.currentHand].status = 'stand'; 
            moveToNextTurn(roomId); 
        } 
    }, 500);
}


// ============================================================================
// 6. GLOBAL ARCADE TICKER (HEARTBEAT LOOP)
// ============================================================================
setInterval(() => {
    const now = Date.now();
    
    // Auto-Kick Idle Blackjack Players
    Object.keys(rooms).forEach(roomId => {
        let room = rooms[roomId]; let changed = false;
        room.seats.forEach((seat, i) => { if (seat && seat.kickAt && now >= seat.kickAt) { room.seats[i] = null; changed = true; } });
        if (changed) { if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });

    // ================== PUNTO BANCO (BACCARAT) ENGINE ==================
    if (baccaratGame.status === 'betting' && now >= baccaratGame.betEndTime) {
        baccaratGame.status = 'drawing'; 
        io.to('arcade_baccarat').emit('baccarat_state_update', { status: baccaratGame.status, timeLeft: 0 });
        
        setTimeout(async () => {
            try {
                let deck = getNewDeck(); baccaratGame.pCards = [deck.pop(), deck.pop()]; baccaratGame.bCards = [deck.pop(), deck.pop()];
                baccaratGame.pVal = (getBaccaratWeight(baccaratGame.pCards[0]) + getBaccaratWeight(baccaratGame.pCards[1])) % 10; 
                baccaratGame.bVal = (getBaccaratWeight(baccaratGame.bCards[0]) + getBaccaratWeight(baccaratGame.bCards[1])) % 10;
                
                let thirdCardTarget = null;
                if (baccaratGame.pVal < 8 && baccaratGame.bVal < 8) {
                    if (baccaratGame.pVal <= 5) {
                        let p3 = deck.pop(); baccaratGame.pCards.push(p3); baccaratGame.pVal = (baccaratGame.pVal + getBaccaratWeight(p3)) % 10; let p3v = getBaccaratWeight(p3); let bDraw = false;
                        thirdCardTarget = 'player';
                        if (baccaratGame.bVal <= 2) bDraw = true; 
                        else if (baccaratGame.bVal === 3 && p3v !== 8) bDraw = true; 
                        else if (baccaratGame.bVal === 4 && ![0,1,8,9].includes(p3v)) bDraw = true; 
                        else if (baccaratGame.bVal === 5 && [4,5,6,7].includes(p3v)) bDraw = true; 
                        else if (baccaratGame.bVal === 6 && [6,7].includes(p3v)) bDraw = true;
                        
                        if(bDraw) { let b3 = deck.pop(); baccaratGame.bCards.push(b3); baccaratGame.bVal = (baccaratGame.bVal + getBaccaratWeight(b3)) % 10; thirdCardTarget = 'both'; }
                    } else if (baccaratGame.bVal <= 5) { 
                        let b3 = deck.pop(); baccaratGame.bCards.push(b3); baccaratGame.bVal = (baccaratGame.bVal + getBaccaratWeight(b3)) % 10; thirdCardTarget = 'banker'; 
                    }
                }

                baccaratGame.status = 'resolving'; 
                baccaratGame.winner = baccaratGame.pVal > baccaratGame.bVal ? 'player' : (baccaratGame.bVal > baccaratGame.pVal ? 'banker' : 'tie');
                baccaratGame.history.unshift(baccaratGame.winner); if(baccaratGame.history.length > 20) baccaratGame.history.pop();
                
                let winners = []; 
                let roundRecord = new GameRound({ game: 'baccarat', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: baccaratGame.winner, players: [] });
                
                for (let b of baccaratGame.bets) {
                    let wonAmount = 0; 
                    if (b.choice === baccaratGame.winner) { 
                        if(b.choice === 'player') wonAmount = b.amount * 2; 
                        else if (b.choice === 'banker') wonAmount = b.amount * 1.95; 
                        else if (b.choice === 'tie') wonAmount = b.amount * 9; 
                    } else if (baccaratGame.winner === 'tie' && ['player', 'banker'].includes(b.choice)) { wonAmount = b.amount; }
                    
                    roundRecord.players.push({ username: b.username, choice: b.choice, bet: b.amount, win: wonAmount });
                    if (wonAmount > 0) {
                        try { 
                            const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                            if(updatedUser) { 
                                await new Transaction({ username: updatedUser.username, type: 'BACCARAT WIN', amount: wonAmount }).save(); 
                                winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); 
                                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                            }
                        } catch(e) {}
                    }
                }
                await roundRecord.save();
                
                io.to('arcade_baccarat').emit('baccarat_state_update', { status: baccaratGame.status, pCards: baccaratGame.pCards, bCards: baccaratGame.bCards, pVal: baccaratGame.pVal, bVal: baccaratGame.bVal, winner: baccaratGame.winner, winners, bets: baccaratGame.bets, history: baccaratGame.history, thirdCardTarget });
                
                // Strict 14-second animation buffer
                setTimeout(() => { 
                    baccaratGame.bets = []; baccaratGame.status = 'betting'; baccaratGame.betEndTime = Date.now() + 15000; 
                    io.to('arcade_baccarat').emit('baccarat_state_update', { status: baccaratGame.status, betEndTime: baccaratGame.betEndTime, history: baccaratGame.history }); 
                }, 14000);

            } catch (err) {
                console.error("BACCARAT CRASH CAUGHT:", err);
                baccaratGame.bets = []; baccaratGame.status = 'betting'; baccaratGame.betEndTime = Date.now() + 15000;
                io.to('arcade_baccarat').emit('baccarat_state_update', { status: baccaratGame.status, betEndTime: baccaratGame.betEndTime });
            }
        }, 1000); 
    }

    // ================== DRAGON VS TIGER ENGINE ==================
    if (dvtGame.status === 'betting' && now >= dvtGame.betEndTime) {
        dvtGame.status = 'drawing'; 
        io.to('arcade_dvt').emit('dvt_state_update', { status: dvtGame.status, timeLeft: 0 });
        setTimeout(async () => {
            try {
                let deck = getNewDeck(); dvtGame.dragonCard = deck.pop(); dvtGame.tigerCard = deck.pop();
                let dVal = getDvtWeight(dvtGame.dragonCard); let tVal = getDvtWeight(dvtGame.tigerCard);
                dvtGame.status = 'resolving'; dvtGame.winner = dVal > tVal ? 'dragon' : (tVal > dVal ? 'tiger' : 'tie');
                dvtGame.history.unshift(dvtGame.winner); if(dvtGame.history.length > 20) dvtGame.history.pop();
                
                let winners = []; let roundRecord = new GameRound({ game: 'dvt', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: dvtGame.winner, players: [] });
                for (let b of dvtGame.bets) {
                    let wonAmount = 0; 
                    if (b.choice === dvtGame.winner) { 
                        if(b.choice === 'dragon' || b.choice === 'tiger') wonAmount = b.amount * 2; else if (b.choice === 'tie') wonAmount = b.amount * 9; 
                    } else if (dvtGame.winner === 'tie' && (b.choice === 'dragon' || b.choice === 'tiger')) { wonAmount = b.amount / 2; }
                    
                    roundRecord.players.push({ username: b.username, choice: b.choice, bet: b.amount, win: wonAmount });
                    if (wonAmount > 0) {
                        try { const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                            if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'DVT WIN', amount: wonAmount }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                        } catch(e) {}
                    }
                }
                await roundRecord.save();
                io.to('arcade_dvt').emit('dvt_state_update', { status: dvtGame.status, dragonCard: dvtGame.dragonCard, tigerCard: dvtGame.tigerCard, winner: dvtGame.winner, winners, bets: dvtGame.bets, history: dvtGame.history });
                setTimeout(() => { dvtGame.bets = []; dvtGame.status = 'betting'; dvtGame.betEndTime = Date.now() + 12000; io.to('arcade_dvt').emit('dvt_state_update', { status: dvtGame.status, betEndTime: dvtGame.betEndTime, history: dvtGame.history }); }, 6000);
            } catch (err) {
                console.error("DVT CRASH CAUGHT:", err);
                dvtGame.bets = []; dvtGame.status = 'betting'; dvtGame.betEndTime = Date.now() + 12000;
            }
        }, 1000); 
    }

    // ================== HIGH-LOW DICE ENGINE ==================
    if (diceGame.status === 'betting' && now >= diceGame.betEndTime) {
        diceGame.status = 'rolling'; 
        io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, timeLeft: 0, history: diceGame.history });
        setTimeout(async () => {
            try {
                let d1 = Math.floor(Math.random() * 6) + 1; let d2 = Math.floor(Math.random() * 6) + 1;
                diceGame.dice = [d1, d2]; const total = d1 + d2;
                diceGame.status = 'resolving'; diceGame.history.unshift(diceGame.dice); if(diceGame.history.length > 20) diceGame.history.pop();
                
                let winners = []; let roundRecord = new GameRound({ game: 'dice', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: total, players: [] });
                for (let b of diceGame.bets) {
                    let won = false; let payout = 0;
                    if (b.choice === 'under' && total < 7) { won = true; payout = b.amount * 2; }
                    if (b.choice === 'over' && total > 7) { won = true; payout = b.amount * 2; }
                    if (b.choice === 'seven' && total === 7) { won = true; payout = b.amount * 5; }
                    
                    roundRecord.players.push({ username: b.username, choice: b.choice, bet: b.amount, win: won ? payout : 0 });
                    if (won) {
                        try { const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: payout } }, {new: true}); 
                            if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'HIGH-LOW DICE WIN', amount: payout }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: payout }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                        } catch(e) {}
                    }
                }
                await roundRecord.save();
                io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, dice: diceGame.dice, total, winners, bets: diceGame.bets, history: diceGame.history });
                setTimeout(() => { diceGame.bets = []; diceGame.status = 'betting'; diceGame.betEndTime = Date.now() + 15000; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); }, 5000);
            } catch(err) {
                console.error("DICE CRASH CAUGHT:", err);
                diceGame.bets = []; diceGame.status = 'betting'; diceGame.betEndTime = Date.now() + 15000;
            }
        }, 3000); 
    }

    // ================== 8-BIT DERBY ENGINE ==================
    if (derbyGame.status === 'betting' && now >= derbyGame.betEndTime) {
        derbyGame.status = 'racing'; 
        derbyGame.distances = [0,0,0,0]; 
        io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, timeLeft: 0, distances: derbyGame.distances, history: derbyGame.history });
        
        let raceTick = 0; let currentSpeeds = [0,0,0,0];
        
        let raceInterval = setInterval(async () => {
            raceTick++; let finished = false; 
            if (raceTick % 10 === 1) { for(let i=0; i<4; i++) currentSpeeds[i] = (Math.random() * 0.7) + 0.45; }
            for(let i=0; i<4; i++) { derbyGame.distances[i] += currentSpeeds[i]; if (derbyGame.distances[i] >= 100) finished = true; }
            io.to('arcade_derby').emit('derby_race_tick', { distances: derbyGame.distances });

            if (finished || raceTick > 150) { 
                clearInterval(raceInterval); 
                try {
                    derbyGame.status = 'resolving';
                    let winnerIndex = 0; let maxDist = -1;
                    for(let i=0; i<4; i++) { if (derbyGame.distances[i] > maxDist) { maxDist = derbyGame.distances[i]; winnerIndex = i; } if (derbyGame.distances[i] > 100) derbyGame.distances[i] = 100; }
                    io.to('arcade_derby').emit('derby_race_tick', { distances: derbyGame.distances });

                    derbyGame.history.unshift(winnerIndex); if(derbyGame.history.length > 20) derbyGame.history.pop();
                    let winners = []; let roundRecord = new GameRound({ game: 'derby', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: winnerIndex, players: [] });

                    for (let b of derbyGame.bets) {
                        let wonAmount = (b.choice === winnerIndex) ? (b.amount * DERBY_ODDS) : 0;
                        roundRecord.players.push({ username: b.username, choice: b.choice, bet: b.amount, win: wonAmount });
                        if (b.choice === winnerIndex) {
                            try { 
                                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                                if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'DERBY WIN', amount: wonAmount }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                            } catch(e) {}
                        }
                    }
                    await roundRecord.save();
                    io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, winner: winnerIndex, winners, bets: derbyGame.bets, history: derbyGame.history, distances: derbyGame.distances });
                    
                    setTimeout(() => { derbyGame.bets = []; derbyGame.status = 'betting'; derbyGame.distances = [0,0,0,0]; derbyGame.betEndTime = Date.now() + 15000; io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, betEndTime: derbyGame.betEndTime, history: derbyGame.history, distances: derbyGame.distances }); }, 5000);
                } catch(err) {
                    console.error("DERBY CRASH CAUGHT:", err);
                    derbyGame.bets = []; derbyGame.status = 'betting'; derbyGame.distances = [0,0,0,0]; derbyGame.betEndTime = Date.now() + 15000;
                }
            }
        }, 100); 
    }

    // ================== PERYA COLOR ENGINE ==================
    if (colorGame.status === 'betting' && now >= colorGame.betEndTime) {
        colorGame.status = 'rolling'; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, timeLeft: 0, history: colorGame.history });
        setTimeout(async () => {
            try {
                colorGame.dice = [PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)]];
                colorGame.status = 'resolving'; colorGame.history.unshift(colorGame.dice); if(colorGame.history.length > 20) colorGame.history.pop();
                
                let winners = []; let roundRecord = new GameRound({ game: 'color', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: colorGame.dice, players: [] });
                for (let b of colorGame.bets) {
                    let matches = colorGame.dice.filter(c => c === b.choice).length; let wonAmount = matches > 0 ? (b.amount + (b.amount * matches)) : 0;
                    roundRecord.players.push({ username: b.username, choice: b.choice.toUpperCase(), bet: b.amount, win: wonAmount });
                    if (matches > 0) {
                        try { const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                            if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'COLOR GAME WIN', amount: wonAmount }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                        } catch(e) {}
                    }
                }
                await roundRecord.save();
                io.to('arcade_color').emit('color_state_update', { status: colorGame.status, dice: colorGame.dice, winners, bets: colorGame.bets, history: colorGame.history });
                setTimeout(() => { colorGame.bets = []; colorGame.status = 'betting'; colorGame.betEndTime = Date.now() + 15000; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); }, 5000);
            } catch(err) {
                console.error("COLOR CRASH CAUGHT:", err);
                colorGame.bets = []; colorGame.status = 'betting'; colorGame.betEndTime = Date.now() + 15000;
            }
        }, 3000); 
    }

    // ================== STREET HUSTLE (CUPS) ENGINE ==================
    if (cupsGame.status === 'shuffling' && now >= cupsGame.stateEndTime) {
        cupsGame.status = 'betting'; cupsGame.betEndTime = now + 7000; cupsGame.stateEndTime = cupsGame.betEndTime;
        io.to('arcade_cups').emit('cups_state_update', { status: cupsGame.status, betEndTime: cupsGame.betEndTime, history: cupsGame.history });
    }
    else if (cupsGame.status === 'betting' && now >= cupsGame.stateEndTime) {
        cupsGame.status = 'resolving'; cupsGame.stateEndTime = now + 5000; 
        (async () => {
            try {
                cupsGame.winningCup = Math.floor(Math.random() * 3); cupsGame.history.unshift(cupsGame.winningCup); if(cupsGame.history.length > 20) cupsGame.history.pop();
                let winners = []; let roundRecord = new GameRound({ game: 'cups', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: cupsGame.winningCup, players: [] });
                for (let b of cupsGame.bets) {
                    let won = (b.choice === cupsGame.winningCup); let wonAmount = won ? (b.amount * 2.5) : 0;
                    roundRecord.players.push({ username: b.username, choice: `CUP ${b.choice + 1}`, bet: b.amount, win: wonAmount });
                    if (won) {
                        try { 
                            const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                            if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'CUPS WIN', amount: wonAmount }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                        } catch(e) {}
                    }
                }
                await roundRecord.save();
                io.to('arcade_cups').emit('cups_state_update', { status: cupsGame.status, winningCup: cupsGame.winningCup, winners, bets: cupsGame.bets, history: cupsGame.history });
                setTimeout(() => { cupsGame.bets = []; cupsGame.status = 'shuffling'; cupsGame.stateEndTime = Date.now() + 3000; io.to('arcade_cups').emit('cups_state_update', { status: cupsGame.status, history: cupsGame.history }); }, 5000);
            } catch(err) {
                console.error("CUPS CRASH CAUGHT:", err);
                cupsGame.bets = []; cupsGame.status = 'shuffling'; cupsGame.stateEndTime = Date.now() + 3000;
            }
        })();
    }

}, 1000);


// ============================================================================
// 7. SOCKET.IO EVENT LISTENERS
// ============================================================================
io.on('connection', (socket) => {
    
    socket.on('admin_join', () => { socket.join('admin_room'); });

    socket.on('admin_action', ({ action, game, room, locked }) => {
        try {
            if(action === 'toggle_game') {
                gameLocks[game] = !locked; io.emit('game_lock_state', gameLocks); adminLog(`KILL SWITCH: ${game.toUpperCase()} set to ${gameLocks[game] ? 'OFFLINE' : 'ONLINE'}`);
            } else if (action === 'wipe_chat') {
                io.to('arcade_' + room).emit('chat_wiped'); adminLog(`CHAT WIPED: ${room.toUpperCase()}`);
            }
        } catch(e){}
    });

    socket.on('req_admin_inbox', async () => {
        try { const tickets = await Ticket.find({}).sort({ updatedAt: -1 }); socket.emit('admin_inbox_data', tickets); } catch(e){}
    });

    socket.on('undo_bet', async ({ username, game }) => {
        try {
            if(gameLocks[game]) return socket.emit('arcade_error', 'Game is currently offline.');
            
            let targetGame;
            if (game === 'dice') targetGame = diceGame; else if (game === 'derby') targetGame = derbyGame;
            else if (game === 'color') targetGame = colorGame; else if (game === 'cups') targetGame = cupsGame;
            else if (game === 'baccarat') targetGame = baccaratGame; else if (game === 'dvt') targetGame = dvtGame;
            else return;

            if (targetGame.status !== 'betting') return socket.emit('arcade_error', 'Cannot undo: Bets are closed!');
            
            let betIndex = -1;
            for(let i = targetGame.bets.length - 1; i >= 0; i--) { if(targetGame.bets[i].username.toLowerCase() === username.toLowerCase()) { betIndex = i; break; } }
            if(betIndex === -1) return socket.emit('arcade_error', 'No bets to undo.');

            let removedBet = targetGame.bets.splice(betIndex, 1)[0];
            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i') }, { $inc: { credits: removedBet.amount } }, { new: true });
            if(user) {
                await new Transaction({ username: user.username, type: `${game.toUpperCase()} UNDO`, amount: removedBet.amount }).save();
                io.emit('credit_update', { username: user.username, credits: user.credits });
                let remainingBetAmt = targetGame.bets.filter(b => b.username.toLowerCase() === username.toLowerCase() && b.choice === removedBet.choice).reduce((sum, b) => sum + b.amount, 0);
                socket.emit('arcade_bet_placed', { game, choice: removedBet.choice, totalChoiceBet: remainingBetAmt });
            }
        } catch(e) {}
    });

    socket.on('get_dvt_state', () => { try { socket.emit('dvt_state_update', { status: dvtGame.status, betEndTime: dvtGame.betEndTime, history: dvtGame.history }); } catch(e){} });
    socket.on('place_dvt_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.dvt) return socket.emit('arcade_error', 'Game is currently offline.');
            if (dvtGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
            let existingBetAmt = dvtGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Bet failed: Insufficient DB funds or user not found.');
            
            await new Transaction({ username: user.username, type: 'DRAGON VS TIGER', amount: -amount }).save();
            let existingBetObj = dvtGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount; else dvtGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'dvt', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) {}
    });

    socket.on('get_baccarat_state', () => { try { socket.emit('baccarat_state_update', { status: baccaratGame.status, betEndTime: baccaratGame.betEndTime, history: baccaratGame.history }); } catch(e){} });
    socket.on('place_baccarat_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.baccarat) return socket.emit('arcade_error', 'Game is currently offline.');
            if (baccaratGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
            let existingBetAmt = baccaratGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Bet failed: Insufficient DB funds.');
            
            await new Transaction({ username: user.username, type: 'BACCARAT', amount: -amount }).save();
            let existingBetObj = baccaratGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount; else baccaratGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'baccarat', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) {}
    });

    socket.on('get_dice_state', () => { try { socket.emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); } catch(e){} });
    socket.on('place_dice_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.dice) return socket.emit('arcade_error', 'Game is currently offline.');
            if (diceGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
            let existingBetAmt = diceGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Bet failed: Insufficient DB funds.');
            
            await new Transaction({ username: user.username, type: 'HIGH-LOW DICE', amount: -amount }).save();
            let existingBetObj = diceGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount; else diceGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'dice', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) {}
    });

    socket.on('get_derby_state', () => { try { socket.emit('derby_state_update', { status: derbyGame.status, betEndTime: derbyGame.betEndTime, distances: derbyGame.distances, history: derbyGame.history }); } catch(e){} });
    socket.on('place_derby_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.derby) return socket.emit('arcade_error', 'Game is currently offline.');
            if (derbyGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per lane!');
            
            let choiceIdx = parseInt(choice); 
            let existingBetLane = derbyGame.bets.find(b => b.username.toLowerCase() === username.toLowerCase());
            if (existingBetLane && existingBetLane.choice !== choiceIdx) return socket.emit('arcade_error', 'You can only bet on ONE lane per race!');
            
            let existingBetAmt = existingBetLane ? existingBetLane.amount : 0;
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per lane!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Bet failed: Insufficient DB funds.');
            
            await new Transaction({ username: user.username, type: '8-BIT DERBY', amount: -amount }).save();
            if (existingBetLane) existingBetLane.amount += amount; else derbyGame.bets.push({ username: user.username, choice: choiceIdx, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits });
            socket.emit('arcade_bet_placed', { game: 'derby', credits: user.credits, choice: choiceIdx, totalChoiceBet: existingBetAmt + amount });
        } catch(e) {}
    });

    socket.on('get_color_state', () => { try { socket.emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); } catch(e){} });
    socket.on('place_color_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.color) return socket.emit('arcade_error', 'Game is currently offline.');
            if (colorGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per color!');
            let existingBetAmt = colorGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per color!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Bet failed: Insufficient DB funds.');
            
            await new Transaction({ username: user.username, type: 'COLOR GAME', amount: -amount }).save();
            let existingBetObj = colorGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount; else colorGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'color', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) {}
    });

    socket.on('get_cups_state', () => { try { socket.emit('cups_state_update', { status: cupsGame.status, betEndTime: cupsGame.betEndTime, history: cupsGame.history }); } catch(e){} });
    socket.on('place_cups_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.cups) return socket.emit('arcade_error', 'Game is currently offline.');
            if (cupsGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            
            let existingOtherBet = cupsGame.bets.find(b => b.username.toLowerCase() === username.toLowerCase() && b.choice !== choice);
            if (existingOtherBet) return socket.emit('arcade_error', 'You can only bet on ONE cup per round!');

            let existingBetAmt = cupsGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per cup!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Bet failed: Insufficient DB funds.');
            
            await new Transaction({ username: user.username, type: '3 CUPS', amount: -amount }).save();
            let existingBetObj = cupsGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount; else cupsGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'cups', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) {}
    });

    socket.on('enter_room', async ({ username, roomId }) => {
        try {
            if (!rooms[roomId]) return; socket.join(roomId); 
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); 
            if (user) { 
                socketUserMap[socket.id] = { username: user.username, roomId }; 
                if(!rooms[roomId].lobby.find(p => p.username === user.username)) { rooms[roomId].lobby.push({ username: user.username, color: user.nameColor }); } 
            }
            emitGameState(roomId);
            broadcastGlobalCounts();
        } catch(e) {}
    });

    socket.on('leave_room', ({ username, roomId }) => {
        try {
            let room = rooms[roomId]; if (!room) return; 
            socket.leave(roomId); 
            room.lobby = room.lobby.filter(p => p.username.toLowerCase() !== username.toLowerCase());
            
            const seatIndex = room.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
            if (seatIndex !== -1) { 
                room.seats[seatIndex] = null; 
                if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } 
            }
            if(socketUserMap[socket.id]) delete socketUserMap[socket.id]; 
            emitGameState(roomId);
            broadcastGlobalCounts();
        } catch(e){}
    });

    socket.on('join_seat', async ({ roomId, username, seatIndex }) => {
        try {
            let room = rooms[roomId]; 
            if (!room || room.seats.some(s => s && s.username.toLowerCase() === username.toLowerCase()) || seatIndex < 0 || seatIndex >= room.seats.length || room.seats[seatIndex]) return;
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return;
            
            room.seats[seatIndex] = { username: user.username, color: user.nameColor, socketId: socket.id, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0, kickAt: Date.now() + 15000 };
            if (room.status === 'waiting') room.status = 'betting'; 
            emitGameState(roomId);
        } catch(e) {}
    });

    socket.on('leave_seat', ({ roomId, username, seatIndex }) => {
        try {
            let room = rooms[roomId]; if (!room) return;
            if (room.seats[seatIndex] && room.seats[seatIndex].username.toLowerCase() === username.toLowerCase()) { 
                room.seats[seatIndex] = null; 
                if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } 
                emitGameState(roomId); 
            }
        } catch(e){}
    });

    socket.on('place_bet', async ({ roomId, username, seatIndex, betAmount }) => {
        try {
            if(gameLocks[roomId]) return socket.emit('arcade_error', 'Table is currently offline.');
            let room = rooms[roomId]; if (!room) return; 
            const seat = room.seats[seatIndex]; 
            if (!seat || seat.username.toLowerCase() !== username.toLowerCase() || room.status !== 'betting') return;
            
            if (betAmount >= 100 && betAmount <= 50000) {
                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: betAmount } }, { $inc: { credits: -betAmount } }, { new: true });
                if (!updatedUser) return socket.emit('arcade_error', 'Bet failed: User not found or insufficient DB funds.');
                
                seat.credits = updatedUser.credits; seat.hands[0].bet = betAmount; seat.kickAt = null; 
                await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId), amount: -betAmount }).save();
                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                
                room.betEndTime = Date.now() + 15000; clearInterval(room.betTimerInterval);
                if (room.seats.every(s => s !== null && s.hands[0].bet > 0)) { clearInterval(room.betTimerInterval); startGame(roomId); } 
                else { room.betTimerInterval = setInterval(() => { if (Date.now() >= room.betEndTime) { clearInterval(room.betTimerInterval); startGame(roomId); } }, 1000); emitGameState(roomId); }
            }
        } catch(e) {}
    });

    socket.on('player_action_hit', ({ roomId, username, seatIndex }) => { 
        try { 
            let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; 
            const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; 
            if (seat.username.toLowerCase() !== username.toLowerCase() || hand.status !== 'waiting') return; 
            
            hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); 
            if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; moveToNextTurn(roomId); } 
            else if (hand.value === 21) { hand.status = 'stand'; moveToNextTurn(roomId); } 
            else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } 
        } catch(e){} 
    });
    
    socket.on('player_action_stand', ({ roomId, username, seatIndex }) => { 
        try { 
            let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; 
            const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; 
            if (seat.username.toLowerCase() !== username.toLowerCase() || hand.status !== 'waiting') return; 
            
            hand.status = 'stand'; moveToNextTurn(roomId); 
        } catch(e){} 
    });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Casino Server Live on port ${PORT}`));
