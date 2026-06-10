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
    status: { type: String, default: 'pending' }, 
    role: { type: String, default: 'player' }, 
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
    status: { type: String, default: 'completed' }, // 'pending', 'completed', 'denied'
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

const GiftCode = mongoose.model('GiftCode', new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    batchName: String,
    amount: Number,
    usesLeft: { type: Number, default: 1 },
    claimedBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
}));

// ============================================================================
// 3. GAME STATE GLOBALS & SYSTEM CACHE
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

let strictHouseEdge = false;
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
// 4. REST APIs - PLAYER ROUTES
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

app.post('/api/bank/request', async (req, res) => {
    try {
        const { username, type, amount } = req.body; 
        let txType = type === 'deposit' ? 'BANK DEPOSIT' : 'BANK WITHDRAWAL'; 
        let currentCredits = undefined;
        
        // Strict Hard-Cap Limit
        if (amount <= 0 || amount > 100000) return res.status(400).json({ error: 'Invalid Limit. Max is 100,000 CR.' });

        if (type === 'withdrawal') {
            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return res.status(400).json({ error: 'Insufficient funds.' }); 
            currentCredits = user.credits;
            await new Transaction({ username, type: txType, amount: amount, status: 'pending' }).save();
        } else if (type === 'deposit') {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if (!user) return res.status(400).json({ error: 'User not found.' }); 
            currentCredits = user.credits;
            await new Transaction({ username, type: txType, amount: amount, status: 'pending' }).save();
        }
        
        adminLog(`New Bank Request: ${username} requested ${type} of ${amount} CR`);
        io.to('admin_room').emit('admin_inbox_update');
        
        res.json({ success: true, newCredits: currentCredits });
    } catch(e) { res.status(500).json({ error: 'Server Error' }); }
});


// ============================================================================
// 5. REST APIs - ADMIN & SYSTEM CONTROLS
// ============================================================================
function authAdmin(req, res, next) {
    const sysAdminPw = process.env.ADMIN_PASSWORD || 'admin123';
    const sysModPw = process.env.MOD_PASSWORD || 'mod123';
    const reqPass = req.headers['x-admin-pass'];
    
    if (reqPass === sysAdminPw || reqPass === sysModPw) {
        req.adminRole = reqPass === sysAdminPw ? 'admin' : 'mod';
        next();
    } else {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
}

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const sysAdminPw = process.env.ADMIN_PASSWORD || 'admin123';
    const sysModPw = process.env.MOD_PASSWORD || 'mod123';

    if (password === sysAdminPw) return res.json({ success: true, role: 'admin' });
    if (password === sysModPw) return res.json({ success: true, role: 'mod' });
    return res.status(401).json({ error: 'Unauthorized.' });
});

app.get('/api/admin/economy', authAdmin, async (req, res) => {
    try {
        const users = await User.find({}, '-password').sort({ createdAt: -1 });
        const bankRequests = await Transaction.find({ status: 'pending', type: /BANK/ }).sort({ date: -1 });
        const codes = await GiftCode.find({}).sort({ createdAt: -1 });
        
        let circulating = 0;
        users.forEach(u => circulating += u.credits);

        const txs = await Transaction.find({ status: 'completed' });
        let totalBets = 0; let totalWins = 0; let promoIssued = 0; let deposits = 0; let withdrawals = 0;
        
        txs.forEach(t => {
            if (t.type === 'BANK DEPOSIT') deposits += t.amount;
            else if (t.type === 'BANK WITHDRAWAL') withdrawals += t.amount;
            else if (['DAILY REWARD', 'GIFT CODE', 'ADMIN CREDIT INJECTION'].includes(t.type)) promoIssued += t.amount;
            else if (t.amount < 0) totalBets += Math.abs(t.amount);
            else if (t.amount > 0) totalWins += t.amount;
        });

        const baseVault = 100000000;
        const vault = baseVault + deposits - withdrawals;
        const ggr = totalBets - totalWins;

        const onlineUsers = Object.values(socketUserMap).map(s => s.username);

        res.json({
            success: true,
            economy: { circulating, vault, baseVault, deposits, withdrawals, ggr, totalBets, totalWins, promoIssued },
            bankRequests, users, codes, gameLocks, strictHouseEdge,
            onlineUsers: [...new Set(onlineUsers)]
        });
    } catch(e) { res.status(500).json({ error: 'Data aggregation failed' }); }
});

app.post('/api/admin/tx/resolve', authAdmin, async (req, res) => {
    try {
        const { id, action } = req.body; // action: 'approve' or 'deny'
        const tx = await Transaction.findById(id);
        if(!tx || tx.status !== 'pending') return res.status(400).json({error: 'Invalid TX'});

        if (action === 'approve') {
            tx.status = 'completed';
            if (tx.type === 'BANK DEPOSIT') {
                const user = await User.findOneAndUpdate({ username: new RegExp('^' + tx.username + '$', 'i') }, { $inc: { credits: tx.amount } }, { new: true });
                if(user) io.emit('credit_update', { username: user.username, credits: user.credits });
            }
            adminLog(`Approved ${tx.type} for ${tx.username} (${tx.amount})`);
        } else {
            tx.status = 'denied';
            if (tx.type === 'BANK WITHDRAWAL') {
                // Refund the held credits
                const user = await User.findOneAndUpdate({ username: new RegExp('^' + tx.username + '$', 'i') }, { $inc: { credits: tx.amount } }, { new: true });
                if(user) io.emit('credit_update', { username: user.username, credits: user.credits });
            }
            adminLog(`Denied ${tx.type} for ${tx.username} (${tx.amount})`);
        }
        await tx.save();
        res.json({ success: true });
    } catch(e) { res.status(500).json({error: 'Resolution failed'}); }
});

app.post('/api/admin/create_user', authAdmin, async (req, res) => {
    try {
        const { username, password, status, role, credits } = req.body;
        const existing = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); 
        if(existing) return res.status(400).json({ error: 'Username taken.' });

        const newUser = new User({
            username, password, status: status || 'active', role: role || 'player',
            credits: credits || 0, inventory: [], tosAccepted: true
        });
        await newUser.save();
        adminLog(`Admin explicitly created user: ${username} [${role}]`);
        res.json({ success: true, message: 'User created.' });
    } catch(e) { res.status(500).json({ error: 'Creation failed.' }); }
});

app.post('/api/admin/update_user', authAdmin, async (req, res) => {
    try {
        const { username, status, role, addCredits } = req.body;
        let updateQuery = {};
        if (status) updateQuery.status = status;
        if (role) updateQuery.role = role;
        
        const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i') }, { $set: updateQuery }, { new: true });
        if (!user) return res.status(404).json({ error: 'User not found.' });

        if (addCredits && !isNaN(parseInt(addCredits))) {
            user.credits += parseInt(addCredits);
            await user.save();
            await new Transaction({ username: user.username, type: 'ADMIN CREDIT INJECTION', amount: parseInt(addCredits) }).save();
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
        }

        adminLog(`Admin updated user profile: ${username}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Update failed.' }); }
});

app.post('/api/admin/giftcode', authAdmin, async (req, res) => {
    try {
        if(req.adminRole !== 'admin') return res.status(403).json({error: 'Master Admin Only'});
        const { batchName, amount, quantity } = req.body;
        
        let codes = [];
        for(let i=0; i<quantity; i++) {
            codes.push({
                code: 'SNT-' + Math.random().toString(36).substr(2, 8).toUpperCase(),
                batchName: batchName || 'PROMO',
                amount: amount,
                usesLeft: 1
            });
        }
        await GiftCode.insertMany(codes);
        adminLog(`Generated ${quantity} gift codes for batch: ${batchName}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Generation failed.' }); }
});

app.post('/api/admin/settings', authAdmin, async (req, res) => {
    try {
        if(req.adminRole !== 'admin') return res.status(403).json({error: 'Master Admin Only'});
        strictHouseEdge = req.body.strictHouseEdge;
        adminLog(`System Setting Modified - RTP Edge set to: ${strictHouseEdge}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Settings update failed.' }); }
});

app.post('/api/admin/change_password', authAdmin, async (req, res) => {
    // In this architecture, passwords are env vars, not DB entries. 
    // Warn the admin that this route is deprecated if using env vars.
    res.status(400).json({ error: 'Passwords are now controlled via Environment Variables (.env or Railway Dashboard) for security. Please update them there and redeploy.' });
});

app.get('/api/admin/game_rounds', authAdmin, async (req, res) => {
    try {
        const rounds = await GameRound.find({}).sort({ timestamp: -1 }).limit(100);
        res.json(rounds);
    } catch(e) { res.status(500).json({ error: 'Fetch failed.' }); }
});

app.get('/api/admin/player_full/:username', authAdmin, async (req, res) => {
    try {
        const username = req.params.username;
        const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }, '-password');
        if(!user) return res.status(404).json({error: 'Not found'});
        
        const txs = await Transaction.find({ username: new RegExp('^' + username + '$', 'i') }).sort({ date: -1 }).limit(50);
        res.json({ user, txs });
    } catch(e) { res.status(500).json({ error: 'Fetch failed.' }); }
});

// ============================================================================
// 6. BLACKJACK ENGINE (ROOMS & DEALER LOGIC)
// ============================================================================
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
        
        let roundRecord = new GameRound({ game: roomId, roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: dealerValue, players: [] });

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
                        
                        roundRecord.players.push({ username: seat.username, choice: hand.value.toString(), bet: hand.bet, win: payout });

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
        await roundRecord.save();
        
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
// 7. GLOBAL ARCADE TICKER (HEARTBEAT LOOP FOR ALL GAMES)
// ============================================================================
setInterval(() => {
    const now = Date.now();
    
    // Auto-Kick Idle Blackjack Players
    Object.keys(rooms).forEach(roomId => {
        let room = rooms[roomId]; let changed = false;
        room.seats.forEach((seat, i) => { if (seat && seat.kickAt && now >= seat.kickAt) { room.seats[i] = null; changed = true; } });
        if (changed) { if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });

    // Handle Expired Auctions
    for (let i = activeAuctions.length - 1; i >= 0; i--) {
        let auc = activeAuctions[i];
        if (now >= auc.endTime) {
            activeAuctions.splice(i, 1);
            if (auc.highestBidder) {
                User.updateOne({username: new RegExp('^' + auc.highestBidder + '$', 'i')}, {$push: {inventory: auc.item}}).exec();
                User.updateOne({username: new RegExp('^' + auc.seller + '$', 'i')}, {$inc: {credits: auc.currentBid}}).exec();
                sendSystemMail(auc.highestBidder, 'AUCTION WON', `You won the auction for ${auc.item} for ${auc.currentBid} CR.`);
            } else {
                User.updateOne({username: new RegExp('^' + auc.seller + '$', 'i')}, {$push: {inventory: auc.item}}).exec();
                sendSystemMail(auc.seller, 'AUCTION EXPIRED', `No one bid on your ${auc.item}. Returned to inventory.`);
            }
            io.emit('market_update', activeAuctions);
        }
    }

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
// 8. SOCKET.IO EVENT LISTENERS (ADMIN, TRADE, INBOX, ROOMS)
// ============================================================================
io.on('connection', (socket) => {
    
    // --- ADMIN SOCKETS ---
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
    socket.on('admin_read_ticket', async ({ id }) => {
        try { const t = await Ticket.findById(id); if(t) { t.unreadAdmin = false; await t.save(); const tickets = await Ticket.find({}).sort({ updatedAt: -1 }); socket.emit('admin_inbox_data', tickets); } } catch(e){}
    });
    socket.on('admin_reply', async ({ id, text }) => {
        try {
            const t = await Ticket.findById(id); if(!t) return;
            t.messages.push({ sender: 'ADMIN', text }); t.unreadPlayer = true; t.updatedAt = Date.now(); await t.save();
            const tickets = await Ticket.find({}).sort({ updatedAt: -1 }); socket.emit('admin_inbox_data', tickets);
            if(t.username !== 'GLOBAL') io.emit('new_mail', { username: t.username });
        } catch(e){}
    });
    socket.on('admin_close_ticket', async ({ id }) => {
        try { const t = await Ticket.findById(id); if(t) { t.status = 'closed'; await t.save(); const tickets = await Ticket.find({}).sort({ updatedAt: -1 }); socket.emit('admin_inbox_data', tickets); } } catch(e){}
    });
    socket.on('admin_notify', async ({ target, username, type, subject, message }) => {
        try {
            if(target === 'all') { const t = new Ticket({ username: 'GLOBAL', target: 'all', type, subject, messages: [{ sender: 'SYSTEM ADMIN', text: message }], unreadPlayer: true, unreadAdmin: false }); await t.save(); io.emit('new_mail', { username: 'GLOBAL' }); }
            else if(target === 'active') { const onlineUsers = Object.values(socketUserMap).map(s => s.username); const unique = [...new Set(onlineUsers)]; for(let u of unique) { await sendSystemMail(u, subject, message); } }
            else { await sendSystemMail(username, subject, message); }
            const tickets = await Ticket.find({}).sort({ updatedAt: -1 }); socket.emit('admin_inbox_data', tickets);
        } catch(e){}
    });

    // --- P2P TRADING SYSTEM ---
    socket.on('req_trade_board', () => { socket.emit('trade_board_update', liveTradeOffers); });
    socket.on('create_trade_offer', async ({ username, item }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(!user || !user.inventory.includes(item)) return;
            liveTradeOffers = liveTradeOffers.filter(o => o.username !== user.username);
            liveTradeOffers.push({ username: user.username, item, socketId: socket.id });
            io.emit('trade_board_update', liveTradeOffers);
        } catch(e) {}
    });
    socket.on('cancel_trade_offer', ({ username }) => {
        try { liveTradeOffers = liveTradeOffers.filter(o => o.username !== username); io.emit('trade_board_update', liveTradeOffers); } catch(e){}
    });
    socket.on('join_trade', async ({ requester, target }) => {
        try {
            const offerIndex = liveTradeOffers.findIndex(o => o.username === target);
            if(offerIndex === -1) return socket.emit('arcade_error', 'Offer no longer available.');
            const offer = liveTradeOffers[offerIndex];
            liveTradeOffers.splice(offerIndex, 1);
            io.emit('trade_board_update', liveTradeOffers);

            const sessionId = 'trade_' + Math.random().toString(36).substr(2, 9);
            activeTradeSessions[sessionId] = {
                p1: { username: offer.username, items: [offer.item], coins: 0, ready: false, finalReady: false, socketId: offer.socketId },
                p2: { username: requester, items: [], coins: 0, ready: false, finalReady: false, socketId: socket.id }
            };

            io.to(offer.socketId).emit('trade_session_start', { sessionId, ...activeTradeSessions[sessionId] });
            socket.emit('trade_session_start', { sessionId, ...activeTradeSessions[sessionId] });
        } catch(e){}
    });
    socket.on('update_trade_offer', ({ sessionId, username, items, coins }) => {
        try {
            const session = activeTradeSessions[sessionId]; if(!session) return;
            const player = session.p1.username === username ? session.p1 : (session.p2.username === username ? session.p2 : null); if(!player) return;
            player.items = items; player.coins = coins; player.ready = false; 
            io.to(session.p1.socketId).emit('trade_session_update', session); io.to(session.p2.socketId).emit('trade_session_update', session);
        } catch(e){}
    });
    socket.on('set_trade_ready', async ({ sessionId, username, ready }) => {
        try {
            const session = activeTradeSessions[sessionId]; if(!session) return;
            const player = session.p1.username === username ? session.p1 : (session.p2.username === username ? session.p2 : null); if(!player) return;
            
            player.ready = ready;
            io.to(session.p1.socketId).emit('trade_session_update', session); io.to(session.p2.socketId).emit('trade_session_update', session);

            if(session.p1.ready && session.p2.ready) {
                session.p1.finalReady = false; session.p2.finalReady = false;
                try {
                    const u1 = await User.findOne({ username: new RegExp('^' + session.p1.username + '$', 'i') });
                    const u2 = await User.findOne({ username: new RegExp('^' + session.p2.username + '$', 'i') });
                    session.p1.joined = u1 ? u1.createdAt : new Date(); session.p2.joined = u2 ? u2.createdAt : new Date();
                } catch(e) {}
                io.to(session.p1.socketId).emit('trade_final_confirm', session); io.to(session.p2.socketId).emit('trade_final_confirm', session);
            }
        } catch(e){}
    });
    socket.on('confirm_final_trade', async ({ sessionId, username }) => {
        try {
            const session = activeTradeSessions[sessionId]; if(!session) return;
            const player = session.p1.username === username ? session.p1 : (session.p2.username === username ? session.p2 : null); if(!player) return;
            
            player.finalReady = true;

            if(session.p1.finalReady && session.p2.finalReady) {
                try {
                    const u1 = await User.findOne({ username: new RegExp('^' + session.p1.username + '$', 'i') });
                    const u2 = await User.findOne({ username: new RegExp('^' + session.p2.username + '$', 'i') });

                    if(u1 && u2 && u1.credits >= session.p1.coins && u2.credits >= session.p2.coins) {
                        let u1Valid = session.p1.items.every(i => u1.inventory.includes(i));
                        let u2Valid = session.p2.items.every(i => u2.inventory.includes(i));

                        if(u1Valid && u2Valid) {
                            u1.credits = (u1.credits - session.p1.coins) + session.p2.coins;
                            u2.credits = (u2.credits - session.p2.coins) + session.p1.coins;

                            session.p1.items.forEach(i => u1.inventory.splice(u1.inventory.indexOf(i), 1));
                            session.p2.items.forEach(i => u2.inventory.splice(u2.inventory.indexOf(i), 1));

                            session.p1.items.forEach(i => u2.inventory.push(i));
                            session.p2.items.forEach(i => u1.inventory.push(i));

                            await u1.save(); await u2.save();

                            io.to(session.p1.socketId).emit('trade_success'); io.to(session.p2.socketId).emit('trade_success');
                            io.emit('credit_update', { username: u1.username, credits: u1.credits });
                            io.emit('credit_update', { username: u2.username, credits: u2.credits });
                        } else {
                            io.to(session.p1.socketId).emit('trade_closed', 'Trade failed. Missing items.'); io.to(session.p2.socketId).emit('trade_closed', 'Trade failed. Missing items.');
                        }
                    } else {
                        io.to(session.p1.socketId).emit('trade_closed', 'Trade failed. Insufficient credits.'); io.to(session.p2.socketId).emit('trade_closed', 'Trade failed. Insufficient credits.');
                    }
                } catch(e) {}
                delete activeTradeSessions[sessionId];
            }
        } catch(e){}
    });
    socket.on('cancel_final_trade', ({ sessionId }) => {
        try {
            const session = activeTradeSessions[sessionId]; if(!session) return;
            session.p1.ready = false; session.p1.finalReady = false; session.p2.ready = false; session.p2.finalReady = false;
            io.to(session.p1.socketId).emit('trade_confirm_canceled'); io.to(session.p2.socketId).emit('trade_confirm_canceled');
            io.to(session.p1.socketId).emit('trade_session_update', session); io.to(session.p2.socketId).emit('trade_session_update', session);
        } catch(e){}
    });
    socket.on('leave_trade', ({ sessionId }) => {
        try {
            const session = activeTradeSessions[sessionId]; if(!session) return;
            io.to(session.p1.socketId).emit('trade_closed', 'Partner canceled the trade.'); io.to(session.p2.socketId).emit('trade_closed', 'Partner canceled the trade.');
            delete activeTradeSessions[sessionId];
        } catch(e){}
    });

    // --- MARKET & AUCTION SYSTEM ---
    socket.on('req_market', async ({ username }) => {
        try { const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(user) socket.emit('market_data', { auctions: activeAuctions, inventory: user.inventory || [] }); } catch(e){}
    });
    socket.on('create_auction', async ({ username, item, startingBid }) => {
        try {
            if(startingBid < 100) return socket.emit('arcade_error', 'Starting bid must be at least 100 CR.');
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(!user || !user.inventory.includes(item)) return socket.emit('arcade_error', 'Item not in inventory.');
            const itemIndex = user.inventory.indexOf(item); user.inventory.splice(itemIndex, 1); await user.save();
            const auction = { id: Math.random().toString(36).substring(2, 9), seller: user.username, item: item, currentBid: startingBid, highestBidder: null, endTime: Date.now() + (5 * 60 * 1000) };
            activeAuctions.push(auction); io.emit('market_update', activeAuctions); socket.emit('market_data', { auctions: activeAuctions, inventory: user.inventory });
        } catch(e){}
    });
    socket.on('place_bid', async ({ id, username, bidAmount }) => {
        try {
            let auc = activeAuctions.find(a => a.id === id);
            if (!auc) return socket.emit('arcade_error', 'Auction not found.');
            if (auc.seller.toLowerCase() === username.toLowerCase()) return socket.emit('arcade_error', 'You cannot bid on your own item.');
            if (bidAmount <= auc.currentBid && auc.highestBidder) return socket.emit('arcade_error', 'Bid must be higher than current bid.');
            if (bidAmount < auc.currentBid && !auc.highestBidder) return socket.emit('arcade_error', 'Bid must meet starting price.');
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if (!user || user.credits < bidAmount) return socket.emit('arcade_error', 'Insufficient credits.');

            user.credits -= bidAmount; await user.save(); io.emit('credit_update', {username: user.username, credits: user.credits});
            if (auc.highestBidder) { const old = await User.findOneAndUpdate({username: new RegExp('^' + auc.highestBidder + '$', 'i')}, {$inc: {credits: auc.currentBid}}, {new: true}); if(old) io.emit('credit_update', {username: old.username, credits: old.credits}); }
            auc.highestBidder = user.username; auc.currentBid = bidAmount;
            if (auc.endTime - Date.now() < 15000) auc.endTime = Date.now() + 15000;
            io.emit('market_update', activeAuctions); socket.emit('market_data', { auctions: activeAuctions, inventory: user.inventory }); 
        } catch(e){}
    });

    // --- INBOX SYSTEM ---
    socket.on('req_inbox', async ({ username }) => { try { const tickets = await Ticket.find({ $or: [{ username: new RegExp('^' + username + '$', 'i') }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 }); socket.emit('inbox_data', tickets); } catch(e){} });
    socket.on('read_ticket', async ({ id, username }) => { try { const t = await Ticket.findById(id); if(t) { if(t.username === 'GLOBAL') { if(!t.readBy.includes(username)) { t.readBy.push(username); await t.save(); } } else { t.unreadPlayer = false; await t.save(); } } } catch(e){} });
    socket.on('player_create_ticket', async ({ username, subject, text }) => { try { const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(!user) return; const t = new Ticket({ username: user.username, target: 'specific', type: 'support', subject, messages: [{ sender: user.username, text }], unreadPlayer: false, unreadAdmin: true }); await t.save(); io.emit('admin_inbox_update'); const tickets = await Ticket.find({ $or: [{ username: user.username }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 }); socket.emit('inbox_data', tickets); } catch(e){} });
    socket.on('player_reply', async ({ id, username, text }) => { try { const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(!user) return; const t = await Ticket.findById(id); if(t && t.status === 'open' && t.type !== 'announcement') { t.messages.push({ sender: user.username, text }); t.unreadAdmin = true; t.updatedAt = Date.now(); await t.save(); socket.emit('ticket_updated', t); io.emit('admin_inbox_update'); } } catch(e){} });
    socket.on('del_ticket', async ({ id, username }) => { try { const t = await Ticket.findById(id); if(t && t.username !== 'GLOBAL') { await Ticket.findByIdAndDelete(id); } const tickets = await Ticket.find({ $or: [{ username: new RegExp('^' + username + '$', 'i') }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 }); socket.emit('inbox_data', tickets); } catch(e){} });

    // --- ARCADE ROOM CONNECTIONS & CHAT ---
    socket.on('enter_arcade', async ({ username, game }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return;
            socket.join('arcade_' + game); socketUserMap[socket.id] = { username: user.username, arcadeGame: game, roomId: 'arcade_' + game };
            let lobby; 
            if(game === 'dice') lobby = diceLobby; else if(game === 'color') lobby = colorLobby; else if(game === 'derby') lobby = derbyLobby; 
            else if(game === 'pvp') lobby = pvpLobby; else if(game === 'cups') lobby = cupsLobby; 
            else if(game === 'baccarat') lobby = baccaratLobby; else if(game === 'dvt') lobby = dvtLobby; else if(game === 'slots') lobby = slotsLobby;
            
            if (lobby && !lobby.find(p => p.username === user.username)) lobby.push({ username: user.username, color: user.nameColor });
            io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
            broadcastGlobalCounts();
        } catch(e) {}
    });

    socket.on('leave_arcade', ({ username, game }) => {
        try {
            socket.leave('arcade_' + game);
            const searchUser = new RegExp('^' + username + '$', 'i');
            let lobby;
            if(game === 'dice') { diceLobby = diceLobby.filter(p => !searchUser.test(p.username)); lobby = diceLobby; }
            else if(game === 'color') { colorLobby = colorLobby.filter(p => !searchUser.test(p.username)); lobby = colorLobby; }
            else if(game === 'derby') { derbyLobby = derbyLobby.filter(p => !searchUser.test(p.username)); lobby = derbyLobby; }
            else if(game === 'cups') { cupsLobby = cupsLobby.filter(p => !searchUser.test(p.username)); lobby = cupsLobby; }
            else if(game === 'baccarat') { baccaratLobby = baccaratLobby.filter(p => !searchUser.test(p.username)); lobby = baccaratLobby; }
            else if(game === 'dvt') { dvtLobby = dvtLobby.filter(p => !searchUser.test(p.username)); lobby = dvtLobby; }
            else if(game === 'slots') { slotsLobby = slotsLobby.filter(p => !searchUser.test(p.username)); lobby = slotsLobby; }
            else if(game === 'pvp') { 
                pvpLobby = pvpLobby.filter(p => !searchUser.test(p.username)); lobby = pvpLobby; 
                const seatIdx = pvpDuel.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
                if(seatIdx !== -1) { pvpDuel.seats[seatIdx] = null; io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel); }
            }
            if(socketUserMap[socket.id]) { delete socketUserMap[socket.id].arcadeGame; delete socketUserMap[socket.id].roomId; }
            io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
            broadcastGlobalCounts();
        } catch(e){}
    });

    socket.on('send_chat', ({ roomId, username, message }) => { 
        try {
            if(roomId && username && message) {
                if (roomId === 'global') io.emit('receive_chat', { roomId, username, message });
                else if (['dice', 'derby', 'color', 'pvp', 'cups', 'baccarat', 'dvt', 'slots'].includes(roomId)) io.to('arcade_' + roomId).emit('receive_chat', { roomId, username, message });
                else io.to(roomId).emit('receive_chat', { roomId, username, message }); 
            }
        } catch(e){}
    });

    // --- ARCADE UNDO BET ---
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

    // --- ARCADE BET PLACEMENTS ---
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

    // --- PVP ARENA SOCKETS ---
    socket.on('get_pvp_state', () => { try { socket.emit('pvp_duel_state_update', pvpDuel); } catch(e){} });
    socket.on('join_pvp_seat', async ({ username, seatIndex }) => {
        try {
            if(seatIndex < 0 || seatIndex > 1) return;
            if(pvpDuel.seats.some(s => s && s?.username.toLowerCase() === username.toLowerCase())) return socket.emit('arcade_error', 'You are already seated.');
            if(pvpDuel.seats[seatIndex]) return socket.emit('arcade_error', 'Seat taken.');
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(!user) return;

            pvpDuel.seats[seatIndex] = { username: user.username, color: user.nameColor, score: 0, choice: '', rpsChoice: '', ready: false };
            if(pvpDuel.hostIndex === -1) {
                pvpDuel.hostIndex = seatIndex; pvpDuel.message = 'HOST CONFIGURING MATCH'; socket.emit('open_pvp_host_modal'); 
            } else {
                pvpDuel.message = 'WAITING FOR CHALLENGER TO ACCEPT';
                socket.emit('open_pvp_accept_modal', { hostName: pvpDuel.seats[pvpDuel.hostIndex]?.username, format: pvpDuel.format, betAmount: pvpDuel.betAmount, type: pvpDuel.type, slices: pvpDuel.slices });
            }
            io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
        } catch(e) {}
    });
    socket.on('leave_pvp_seat', ({ username, seatIndex }) => {
        try { const seat = pvpDuel.seats[seatIndex]; if (seat && seat.username.toLowerCase() === username.toLowerCase()) { pvpDuel.seats[seatIndex] = null; io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel); } } catch(e){}
    });

    // --- BLACKJACK ROOMS & DEALER LOGIC SOCKETS ---
    socket.on('enter_room', async ({ username, roomId }) => {
        try {
            if (!rooms[roomId]) return; socket.join(roomId); 
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); 
            if (user) { 
                socketUserMap[socket.id] = { username: user.username, roomId }; 
                if(!rooms[roomId].lobby.find(p => p.username === user.username)) { rooms[roomId].lobby.push({ username: user.username, color: user.nameColor }); } 
            }
            emitGameState(roomId); broadcastGlobalCounts();
        } catch(e) {}
    });
    socket.on('leave_room', ({ username, roomId }) => {
        try {
            let room = rooms[roomId]; if (!room) return; socket.leave(roomId); 
            room.lobby = room.lobby.filter(p => p.username.toLowerCase() !== username.toLowerCase());
            const seatIndex = room.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
            if (seatIndex !== -1) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } }
            if(socketUserMap[socket.id]) delete socketUserMap[socket.id]; 
            emitGameState(roomId); broadcastGlobalCounts();
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
                room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); 
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
    socket.on('player_action_double', async ({ roomId, username, seatIndex }) => { 
        try { 
            let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; 
            const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; 
            if (seat.username.toLowerCase() !== username.toLowerCase() || hand.status !== 'waiting' || hand.cards.length !== 2) return; 
            
            const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); 
            if (!updatedUser) return socket.emit('arcade_error', 'Insufficient credits to double.');
            
            seat.credits = updatedUser.credits; await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId) + ' DOUBLE', amount: -hand.bet }).save(); 
            io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
            
            hand.bet *= 2; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); 
            if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; } else { hand.status = 'stand'; } 
            moveToNextTurn(roomId); 
        } catch(e){} 
    });
    socket.on('player_action_split', async ({ roomId, username, seatIndex }) => { 
        try { 
            let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; 
            const seat = room.seats[seatIndex]; if (seat.username.toLowerCase() !== username.toLowerCase() || seat.hands.length >= 2) return; 
            const hand = seat.hands[seat.currentHand]; if (hand.status !== 'waiting' || hand.cards.length !== 2) return; 
            
            if (hand.cards[0].weight === hand.cards[1].weight) { 
                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); 
                if (!updatedUser) return socket.emit('arcade_error', 'Insufficient credits to split.');
                
                seat.credits = updatedUser.credits; await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId) + ' SPLIT', amount: -hand.bet }).save(); 
                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                
                const splitCard = hand.cards.pop(); const newHand = { cards: [splitCard], bet: hand.bet, status: 'waiting', value: 0 }; 
                hand.cards.push(room.deck.pop()); newHand.cards.push(room.deck.pop()); 
                hand.value = calculateValue(hand.cards); newHand.value = calculateValue(newHand.cards); 
                if(hand.value === 21) hand.status = 'stand'; if(newHand.value === 21) newHand.status = 'stand'; 
                seat.hands.push(newHand); 
                
                if(hand.status === 'stand') { moveToNextTurn(roomId); } 
                else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } 
            } 
        } catch(e){} 
    });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Casino Server Live on port ${PORT}`));
