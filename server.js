// --- server.js ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs'); 
const path = require('path'); 
const { Resend } = require('resend'); 
const crypto = require('crypto'); 

const resend = new Resend(process.env.RESEND_API_KEY); 

app.use(express.json()); 

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

function hashPwd(pwd) { 
    return crypto.createHash('sha256').update(pwd).digest('hex'); 
}

const activeSessions = {}; 

app.post('/send-message', async (req, res) => {
    const userName = req.body.name || "Unbekannter Spieler";
    const userMessage = req.body.message;

    console.log("=== API KEY CHECK ===");
    console.log("Wurde ein Key gefunden?:", process.env.RESEND_API_KEY ? "JA ✅" : "NEIN ❌ (Ist undefined)");
    if (process.env.RESEND_API_KEY) {
        console.log("Länge des Keys:", process.env.RESEND_API_KEY.length, "Zeichen");
        console.log("Fängt an mit:", process.env.RESEND_API_KEY.substring(0, 4));
    }
    console.log("=======================");

    try {
        const data = await resend.emails.send({
            from: 'Go-Rush Server <onboarding@resend.dev>', 
            to: 'go.rush.server@gmail.com',  
            subject: `💡 Neues Feedback von ${userName}`,
            text: `Spieler: ${userName}\n\nNachricht:\n${userMessage}`
        });
        console.log("E-Mail gesendet:", data);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Fehler beim E-Mail-Versand:", error);
        res.status(500).json({ success: false });
    }
});

const dbFile = path.join(__dirname, 'database.json');
let userDB = {};

if (fs.existsSync(dbFile)) {
    try { userDB = JSON.parse(fs.readFileSync(dbFile, 'utf-8')); } 
    catch(e) { console.log("Fehler beim Laden der DB, starte neu."); userDB = {}; }
}

function saveDB() { fs.writeFileSync(dbFile, JSON.stringify(userDB, null, 2)); }

const SHOP_ITEMS = {
    title_ronin: { type: 'title', name: '[Ronin]', price: 200 },
    title_gott: { type: 'title', name: '[Go-Gott]', price: 1000 },
    aura_gold: { type: 'aura', name: 'Gold', price: 500, class: 'aura-gold' },
    aura_fire: { type: 'aura', name: 'Feuer', price: 1500, class: 'aura-fire' }
};

function getRank(elo) {
    if(elo < 1000) return "30k";
    let kyu = 30 - Math.floor((elo - 1000) / 100);
    if(kyu > 0) return kyu + "k";
    let dan = Math.floor((elo - 4000) / 100) + 1; 
    return dan + "d";
}

function addPetXp(u, amount, socketId) {
    if(!u.pet) u.pet = { xp: 0, level: 0, emoji: '🥚' };
    u.pet.xp += amount;
    let oldLevel = u.pet.level;
    
    if(u.pet.xp >= 300) { u.pet.level = 2; u.pet.emoji = '🐉'; }
    else if(u.pet.xp >= 100) { u.pet.level = 1; u.pet.emoji = '🐣'; }
    
    if(u.pet.level > oldLevel && socketId) {
        io.to(socketId).emit('pet_evolved', u.pet);
    }
}

function finishMatch(matchId, winnerColor, reasonStr) {
    let match = active1v1Matches[matchId];
    if(!match) return;
    
    let winner = match.players[winnerColor];
    let loser = match.players[winnerColor === 'black' ? 'white' : 'black'];
    
    if(match.dcTimers) {
        if(match.dcTimers.black) clearTimeout(match.dcTimers.black);
        if(match.dcTimers.white) clearTimeout(match.dcTimers.white);
    }

    // NEU: Bot Check - Keine Punkte bei Trainingsspielen
    if (winner.isBot || loser.isBot) {
        reasonStr += `<br><br><span style="color:#f59e0b;">(Trainingsspiel - Kein Elo berechnet)</span>`;
        io.to(matchId).emit('1v1_game_over', { reason: reasonStr, moveList: match.moveList, size: match.size });
        delete active1v1Matches[matchId];
        return;
    }

    let wToken = winner.token; let lToken = loser.token;
    if(userDB[wToken] && userDB[lToken] && wToken !== lToken) { 
        let w = userDB[wToken]; let l = userDB[lToken];
        let expW = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
        let expL = 1 / (1 + Math.pow(10, (w.elo - l.elo) / 400));
        
        let pointChangeW = Math.round(32 * (1 - expW));
        let pointChangeL = Math.round(32 * (0 - expL));
        
        w.elo += pointChangeW; l.elo += pointChangeL;
        w.wins = (w.wins || 0) + 1; l.losses = (l.losses || 0) + 1;
        w.coins = (w.coins || 0) + 100; l.coins = (l.coins || 0) + 20;

        let dateStr = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        w.matchHistory = w.matchHistory || [];
        w.matchHistory.unshift({ opponent: loser.name, result: 'Sieg', eloChange: '+' + pointChangeW, date: dateStr });
        if(w.matchHistory.length > 5) w.matchHistory.pop();

        l.matchHistory = l.matchHistory || [];
        l.matchHistory.unshift({ opponent: winner.name, result: 'Niederlage', eloChange: pointChangeL, date: dateStr });
        if(l.matchHistory.length > 5) l.matchHistory.pop();

        let todayStr = new Date().toISOString().split('T')[0];
        if (w.quests && w.quests.date === todayStr) {
            if (w.quests.play.current < w.quests.play.target) w.quests.play.current++;
            if (w.quests.win.current < w.quests.win.target) w.quests.win.current++;
        }
        if (l.quests && l.quests.date === todayStr) {
            if (l.quests.play.current < l.quests.play.target) l.quests.play.current++;
        }
        
        addPetXp(w, 30, winner.id);
        addPetXp(l, 10, loser.id);

        saveDB();
        
        w.rank = getRank(w.elo); l.rank = getRank(l.elo);
        io.to(winner.id).emit('update_stats', w);
        io.to(loser.id).emit('update_stats', l);
        
        reasonStr += `<br><br><span style="color:#10b981;">${winner.name}: +${pointChangeW} Elo & +100 🪙</span><br><span style="color:#ef4444;">${loser.name}: ${pointChangeL} Elo & +20 🪙</span>`;
    }
    
    io.to(matchId).emit('1v1_game_over', { reason: reasonStr, moveList: match.moveList, size: match.size });
    delete active1v1Matches[matchId];
    broadcastMatchmaking();
}

function parseSGF(sgfString, msg, solutionsArray) {
    const setup = []; const cleanSgf = sgfString.replace(/\s+/g, ''); 
    const blackMatch = cleanSgf.match(/AB(\[[a-zA-Z]{2}\])+/g);
    if (blackMatch) blackMatch.forEach(block => { const points = block.replace('AB', '').match(/[a-zA-Z]{2}/g); if (points) points.forEach(pt => setup.push({ x: pt.toLowerCase().charCodeAt(0) - 97, y: pt.toLowerCase().charCodeAt(1) - 97, c: "black" })); });
    const whiteMatch = cleanSgf.match(/AW(\[[a-zA-Z]{2}\])+/g);
    if (whiteMatch) whiteMatch.forEach(block => { const points = block.replace('AW', '').match(/[a-zA-Z]{2}/g); if (points) points.forEach(pt => setup.push({ x: pt.toLowerCase().charCodeAt(0) - 97, y: pt.toLowerCase().charCodeAt(1) - 97, c: "white" })); });
    const solutionCoords = solutionsArray.map(sol => ({ x: sol.toLowerCase().charCodeAt(0) - 97, y: sol.toLowerCase().charCodeAt(1) - 97 }));
    return { msg: msg, setup: setup, solution: solutionCoords };
}

function shuffle(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } }

let globalPuzzles = [];
function loadPuzzles() {
    globalPuzzles = []; const puzzlesDir = path.join(__dirname, 'puzzles');
    if (!fs.existsSync(puzzlesDir)) fs.mkdirSync(puzzlesDir);
    const files = fs.readdirSync(puzzlesDir).filter(f => f.endsWith('.sgf'));
    files.forEach(file => {
        const content = fs.readFileSync(path.join(puzzlesDir, file), 'utf-8');
        const sgfParts = content.split(/(?<=\))\s*(?=\()/); 
        sgfParts.forEach((part, index) => {
            const cleanPart = part.trim(); if (cleanPart.length < 10) return; 
            let msg = file.replace('.sgf', '').replace(/_/g, ' '); if (sgfParts.length > 1) msg += ` (#${index + 1})`;
            const firstMoveMatch = cleanPart.match(/;[BW]\[([a-zA-Z]{2})\]/);
            if (firstMoveMatch) {
                let solutions = [firstMoveMatch[1]]; const altMatches = cleanPart.match(/\(\s*;[BW]\[([a-zA-Z]{2})\]/g);
                if (altMatches) altMatches.forEach(m => solutions.push(m.match(/\[([a-zA-Z]{2})\]/)[1])); solutions = [...new Set(solutions)];
                const setupPart = cleanPart.split(/;[BW]\[/)[0] + ")"; const parsedPuzzle = parseSGF(setupPart, msg, solutions);
                if (parsedPuzzle.setup.length > 0) globalPuzzles.push(parsedPuzzle);
            }
        });
    });
    if (globalPuzzles.length === 0) globalPuzzles.push(parseSGF("(;GM[1]FF[4]SZ[19]AB[dd]AW[pp];B[qq])", "Fallback", ["qq"]));
}
loadPuzzles();

function getNeighbors(x, y, size) {
    let n = [];
    if (size === 'polar') {
        n.push({x: (x + 1) % 24, y: y});
        n.push({x: (x - 1 + 24) % 24, y: y});
        if (y < 5) n.push({x: x, y: y + 1});
        if (y > 0) n.push({x: x, y: y - 1});
    } else {
        n.push({x: x + 1, y: y}); n.push({x: x - 1, y: y});
        n.push({x: x, y: y + 1}); n.push({x: x, y: y - 1});
        n = n.filter(pt => pt.x >= 0 && pt.x < size && pt.y >= 0 && pt.y < size);
    }
    return n;
}

function checkCaptures(board, x, y, colorTarget, size) {
    let captured = []; let visited = new Set();
    function getGroup(gx, gy) {
        let group = []; let liberties = 0; let queue = [{x: gx, y: gy}];
        visited.add(`${gx},${gy}`);
        while(queue.length > 0) {
            let curr = queue.shift(); group.push(curr);
            let neighbors = getNeighbors(curr.x, curr.y, size);
            for(let n of neighbors) {
                let neighborState = board[n.x][n.y];
                if(neighborState === null) liberties++;
                else if(neighborState === colorTarget && !visited.has(`${n.x},${n.y}`)) { visited.add(`${n.x},${n.y}`); queue.push(n); }
            }
        }
        return {group, liberties};
    }
    let neighbors = getNeighbors(x, y, size);
    for(let n of neighbors) {
        if(board[n.x][n.y] === colorTarget && !visited.has(`${n.x},${n.y}`)) {
            let {group, liberties} = getGroup(n.x, n.y);
            if(liberties === 0) group.forEach(stone => captured.push(stone));
        }
    }
    return captured;
}

function getGroupOfColor(board, startX, startY, size) {
    let color = board[startX][startY]; if (!color) return [];
    let group = []; let visited = new Set(); let queue = [{x: startX, y: startY}]; visited.add(`${startX},${startY}`);
    while(queue.length > 0) {
        let curr = queue.shift(); group.push(curr);
        let neighbors = getNeighbors(curr.x, curr.y, size);
        for(let n of neighbors) {
            if(board[n.x][n.y] === color && !visited.has(`${n.x},${n.y}`)) { visited.add(`${n.x},${n.y}`); queue.push(n); }
        }
    }
    return group;
}

function calculateJapaneseScore(board, captures, deadStonesSet, komi, size) {
    let w = size === 'polar' ? 24 : size; let h = size === 'polar' ? 6 : size;
    let blackTerritory = 0; let whiteTerritory = 0;
    let finalCaptures = { black: captures.black, white: captures.white };
    let territoryMap = [];

    let scoreBoard = board.map(row => [...row]);
    deadStonesSet.forEach(pos => {
        let [x, y] = pos.split(',').map(Number); let color = scoreBoard[x][y];
        if (color === 'black') finalCaptures.white++; if (color === 'white') finalCaptures.black++; 
        scoreBoard[x][y] = null; 
    });

    let visited = Array(w).fill(0).map(() => Array(h).fill(false));
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            if (scoreBoard[x][y] === null && !visited[x][y]) {
                let queue = [{x, y}]; visited[x][y] = true; let touchesBlack = false; let touchesWhite = false; let emptyCount = 0;
                let currentRegion = [{x, y}];
                while (queue.length > 0) {
                    let curr = queue.shift(); emptyCount++;
                    let neighbors = getNeighbors(curr.x, curr.y, size);
                    for (let n of neighbors) {
                        if (scoreBoard[n.x][n.y] === 'black') touchesBlack = true;
                        else if (scoreBoard[n.x][n.y] === 'white') touchesWhite = true;
                        else if (!visited[n.x][n.y]) { visited[n.x][n.y] = true; queue.push(n); currentRegion.push(n); }
                    }
                }
                if (touchesBlack && !touchesWhite) {
                    blackTerritory += emptyCount;
                    currentRegion.forEach(pt => territoryMap.push({x: pt.x, y: pt.y, owner: 'black'}));
                }
                if (touchesWhite && !touchesBlack) {
                    whiteTerritory += emptyCount;
                    currentRegion.forEach(pt => territoryMap.push({x: pt.x, y: pt.y, owner: 'white'}));
                }
            }
        }
    }
    return { 
        blackTotal: blackTerritory + finalCaptures.black, whiteTotal: whiteTerritory + finalCaptures.white + komi, 
        blackTerr: blackTerritory, whiteTerr: whiteTerritory, blackCaps: finalCaptures.black, whiteCaps: finalCaptures.white,
        territoryMap: territoryMap
    };
}

function getHandicapStones(size, count) {
    if(count < 2 || size === 'polar') return []; 
    let stones = []; let c1 = size===19?3:size===13?3:2; let c2 = size===19?15:size===13?9:6; let mid = size===19?9:size===13?6:4;
    if(count >= 2) stones.push({x:c2,y:c1}, {x:c1,y:c2});
    if(count >= 3) stones.push({x:c2,y:c2});
    if(count >= 4) stones.push({x:c1,y:c1});
    if(count === 5 || count === 7 || count === 9) stones.push({x:mid,y:mid});
    if(count >= 6) { stones.push({x:c1,y:mid}, {x:c2,y:mid}); }
    if(count >= 8) { stones.push({x:mid,y:c1}, {x:mid,y:c2}); }
    return stones.slice(0, count);
}

const rooms = {}; const challenges = {}; const active1v1Matches = {}; 

function initRoom(roomId) {
    if (!rooms[roomId]) { let roomPuzzles = [...globalPuzzles]; shuffle(roomPuzzles); rooms[roomId] = { id: roomId, players: {}, isPlaying: false, currentLevel: 0, hostId: null, settings: { timeLimit: 10, puzzleCount: roomPuzzles.length }, interval: null, puzzles: roomPuzzles, originalPuzzles: roomPuzzles }; }
}
initRoom('public');

function broadcastLeaderboard(roomId) { if (!rooms[roomId]) return; const sortedPlayers = Object.values(rooms[roomId].players).sort((a, b) => b.score - a.score); io.to(roomId).emit('update_leaderboard', sortedPlayers); }

function broadcastMatchmaking() {
    const activeList = Object.values(active1v1Matches).map(m => ({ id: m.id, size: m.size, playerBlack: m.players.black, playerWhite: m.players.white }));
    io.emit('update_challenges', { challenges: Object.values(challenges), activeMatches: activeList });
}

// --- NEU: ZENTRALE FUNKTION FÜR ZÜGE (Mensch & Bot) ---
function processMove(matchId, playerId, x, y, isPass) {
    const match = active1v1Matches[matchId];
    if(!match || match.state !== 'playing') return false;
    
    let myColor = null;
    if (match.players.black.id === playerId) myColor = 'black';
    else if (match.players.white.id === playerId) myColor = 'white';
    
    if(!myColor || match.turn !== myColor) return false; 

    if (isPass) {
        match.passes++; match.turn = (myColor === 'black') ? 'white' : 'black'; match.moveList.push({ color: myColor, pass: true });
        if(match.timers[myColor].main <= 0 && match.timers[myColor].periods > 0) match.timers[myColor].byo = match.settings.byoTime;
        
        if(match.passes >= 2) { 
            match.state = 'scoring'; 
            let scoreData = calculateJapaneseScore(match.board, match.captures, match.deadStones, match.komi, match.size);
            io.to(matchId).emit('1v1_scoring_phase', { deadStones: Array.from(match.deadStones), accepts: match.accepts, scoreData: scoreData }); 
            
            if(match.players.black.isBot || match.players.white.isBot) {
                let botColor = match.players.black.isBot ? 'black' : 'white';
                match.accepts[botColor] = true;
            }
        } else {
            io.to(matchId).emit('1v1_update_board', { board: match.board, turn: match.turn, lastMove: null, captures: match.captures });
        }
        return true;
    }

    if(x === undefined || y === undefined || match.board[x][y] !== null) return false;

    let newBoard = match.board.map(row => [...row]);
    newBoard[x][y] = myColor;

    const enemyColor = (myColor === 'black') ? 'white' : 'black';
    let capturedStones = checkCaptures(newBoard, x, y, enemyColor, match.size);
    capturedStones.forEach(stone => { newBoard[stone.x][stone.y] = null; });

    let suicideCheck = checkCaptures(newBoard, x, y, myColor, match.size);
    if(suicideCheck.length > 0 && capturedStones.length === 0) { 
        if(!match.players[myColor].isBot) io.to(playerId).emit('1v1_illegal_move', "Selbstmord ist nicht erlaubt!"); 
        return false; 
    }

    let boardString = JSON.stringify(newBoard);
    if(match.history.has(boardString)) { 
        if(!match.players[myColor].isBot) io.to(playerId).emit('1v1_illegal_move', "Ko-Regel: Diese Stellung gab es gerade schon!"); 
        return false; 
    }

    match.captures[myColor] += capturedStones.length;
    match.board = newBoard; match.history.add(boardString); match.turn = enemyColor; match.passes = 0;
    
    if(match.timers[myColor].main <= 0 && match.timers[myColor].periods > 0) { match.timers[myColor].byo = match.settings.byoTime; }
    match.moveList.push({ color: myColor, x: x, y: y });
    
    io.to(matchId).emit('1v1_update_board', { board: match.board, turn: match.turn, lastMove: {x: x, y: y}, captures: match.captures });
    return true;
}

// --- NEU: DUMMY JAVASCRIPT BOT LOGIK (Platzhalter für GnuGo) ---
function triggerBotMove(matchId) {
    setTimeout(() => {
        let match = active1v1Matches[matchId];
        if (!match || match.state !== 'playing') return;
        
        let botColor = match.turn;
        let botPlayer = match.players[botColor];
        if (!botPlayer.isBot) return;

        let enemyColor = botColor === 'black' ? 'white' : 'black';
        let validMoves = [];
        let w = match.size === 'polar' ? 24 : match.size;
        let h = match.size === 'polar' ? 6 : match.size;

        for(let x=0; x<w; x++) {
            for(let y=0; y<h; y++) {
                if(match.board[x][y] === null) {
                    let tempBoard = match.board.map(r => [...r]);
                    tempBoard[x][y] = botColor;
                    let caps = checkCaptures(tempBoard, x, y, enemyColor, match.size);
                    let suicide = checkCaptures(tempBoard, x, y, botColor, match.size);
                    
                    if(suicide.length === 0 || caps.length > 0) {
                        let boardString = JSON.stringify(tempBoard);
                        if(!match.history.has(boardString)) {
                            validMoves.push({x, y});
                        }
                    }
                }
            }
        }

        if(validMoves.length === 0) {
            processMove(matchId, botPlayer.id, null, null, true); 
        } else {
            let choice = validMoves[Math.floor(Math.random() * validMoves.length)];
            processMove(matchId, botPlayer.id, choice.x, choice.y, false);
        }
    }, 1500); // 1.5 Sekunden "Bedenkzeit" simulieren
}

setInterval(() => {
    for (let matchId in active1v1Matches) {
        let match = active1v1Matches[matchId];
        if (match.state === 'playing') {
            let t = match.timers[match.turn];
            if (t.main > 0) { t.main--; } else {
                if (t.byo > 0) t.byo--;
                else {
                    if (t.periods > 0) { t.periods--; t.byo = match.settings.byoTime; } 
                    else {
                        let winnerColor = match.turn === 'black' ? 'white' : 'black'; let winner = match.players[winnerColor];
                        finishMatch(matchId, winnerColor, `⏱️ Zeit abgelaufen! ${winner.avatar} ${winner.name} gewinnt.`); continue;
                    }
                }
            }
            io.to(matchId).emit('1v1_timer_update', { timers: match.timers, turn: match.turn });
        }
    }
}, 1000);

io.on('connection', (socket) => {
    let currentRoom = null; 

    socket.on('login', (data) => {
        if (!data.name || !data.password) return socket.emit('login_error', 'Name und Passwort erforderlich!');
        
        let token = data.name.trim().toLowerCase(); 
        let today = new Date().toISOString().split('T')[0];

        if(!userDB[token]) { 
            userDB[token] = { 
                name: data.name.trim(), 
                password: hashPwd(data.password), 
                elo: 1000, wins: 0, losses: 0, coins: 0, inventory: [], equipped: {title: null, aura: null}, lastLogin: null, matchHistory: [],
                pet: { xp: 0, level: 0, emoji: '🥚' } 
            }; 
        } else {
            if(userDB[token].password && userDB[token].password !== hashPwd(data.password)) {
                return socket.emit('login_error', 'Falsches Passwort für diesen Spielernamen!');
            }
            if(!userDB[token].password) userDB[token].password = hashPwd(data.password);
        }

        if (activeSessions[token] && activeSessions[token] !== socket.id) {
            let oldSocket = io.sockets.sockets.get(activeSessions[token]);
            if (oldSocket) {
                oldSocket.emit('force_logout', '⚠️ Verbindung getrennt: Jemand anderes (vielleicht du am Handy?) hat sich mit deinem Account angemeldet.');
                oldSocket.disconnect(true);
            }
        }
        activeSessions[token] = socket.id;
        socket.userToken = token;

        let u = userDB[token]; 
        u.name = data.name.trim();
        u.avatar = data.avatar;
        u.coins = u.coins || 0; u.inventory = u.inventory || []; u.equipped = u.equipped || {title: null, aura: null};
        u.wins = u.wins || 0; u.losses = u.losses || 0; u.matchHistory = u.matchHistory || [];
        
        if(!u.pet) u.pet = { xp: 0, level: 0, emoji: '🥚' };

        if(!u.quests || u.quests.date !== today) {
            u.quests = {
                date: today,
                play: { current: 0, target: 3, reward: 50, claimed: false, desc: "⚔️ Spiele 3x 1v1-Arena" },
                win: { current: 0, target: 1, reward: 50, claimed: false, desc: "🏆 Gewinne 1x 1v1-Arena" },
                tsumego: { current: 0, target: 5, reward: 30, claimed: false, desc: "🧩 Löse 5 Tsumegos" }
            };
        }

        let dailyReward = 0;
        if(u.lastLogin !== today) { u.coins += 50; u.lastLogin = today; dailyReward = 50; }
        u.rank = getRank(u.elo); saveDB();
        
        let reconnectedMatch = null;
        let myPvpColor = null;
        for(let mId in active1v1Matches) {
            let m = active1v1Matches[mId];
            if(m.players.black.token === token) { myPvpColor = 'black'; reconnectedMatch = m; }
            else if(m.players.white.token === token) { myPvpColor = 'white'; reconnectedMatch = m; }
        }

        if(reconnectedMatch) {
            reconnectedMatch.players[myPvpColor].id = socket.id; 
            
            if(reconnectedMatch.dcTimers && reconnectedMatch.dcTimers[myPvpColor]) {
                clearTimeout(reconnectedMatch.dcTimers[myPvpColor]);
                delete reconnectedMatch.dcTimers[myPvpColor];
            }
            
            socket.join(reconnectedMatch.id);
            socket.emit('1v1_match_reconnected', { 
                roomId: reconnectedMatch.id, size: reconnectedMatch.size, 
                playerBlack: reconnectedMatch.players.black.name, avatarBlack: reconnectedMatch.players.black.avatar, 
                playerWhite: reconnectedMatch.players.white.name, avatarWhite: reconnectedMatch.players.white.avatar, 
                myColor: myPvpColor, komi: reconnectedMatch.komi, 
                board: reconnectedMatch.board, turn: reconnectedMatch.turn, captures: reconnectedMatch.captures,
                timers: reconnectedMatch.timers, state: reconnectedMatch.state, deadStones: Array.from(reconnectedMatch.deadStones) 
            });
            socket.to(reconnectedMatch.id).emit('1v1_opponent_reconnected', { color: myPvpColor });
        }

        socket.emit('login_success', { token: token });
        socket.emit('update_stats', u);
        if(dailyReward > 0) socket.emit('daily_reward', dailyReward);
    });

    socket.on('claim_quest', (data) => {
        let u = userDB[data.token];
        if(u && u.quests && u.quests[data.questId]) {
            let q = u.quests[data.questId];
            if(q.current >= q.target && !q.claimed) {
                q.claimed = true;
                u.coins += q.reward;
                saveDB();
                socket.emit('update_stats', u);
                socket.emit('quest_claimed', { reward: q.reward, id: data.questId });
            }
        }
    });

    socket.on('delete_profile', (token) => { if(userDB[token]) { delete userDB[token]; saveDB(); } });
    socket.on('request_challenges', () => { broadcastMatchmaking(); });
    
    socket.on('buy_item', (data) => {
        let u = userDB[data.token]; let item = SHOP_ITEMS[data.itemId];
        if(u && item && u.coins >= item.price && !u.inventory.includes(data.itemId)) { u.coins -= item.price; u.inventory.push(data.itemId); saveDB(); socket.emit('update_stats', u); }
    });

    socket.on('equip_item', (data) => {
        let u = userDB[data.token]; let item = SHOP_ITEMS[data.itemId];
        if(u && item && u.inventory.includes(data.itemId)) {
            if(u.equipped[item.type] === data.itemId) { u.equipped[item.type] = null; } else { u.equipped[item.type] = data.itemId; }
            saveDB(); socket.emit('update_stats', u);
        }
    });

    // NEU: Event für das Starten eines Bot-Spiels
    socket.on('start_bot_match', (data) => {
        const newRoomId = 'bot_' + Math.random().toString(36).substring(2,8);
        let bSize = parseInt(data.boardSize);
        let emptyBoard = Array(bSize).fill(null).map(() => Array(bSize).fill(null));
        
        let botName = "Bot (Lvl " + data.level + ")";
        let botAvatar = "🤖";
        
        active1v1Matches[newRoomId] = {
            id: newRoomId, size: bSize, board: emptyBoard, turn: 'black', passes: 0,
            state: 'playing', komi: 6.5, handicapStones: [], settings: { byoTime: 30 },
            deadStones: new Set(), accepts: { black: false, white: false },
            history: new Set([JSON.stringify(emptyBoard)]), moveList: [], 
            timers: { black: { main: 600, byo: 30, periods: 3 }, white: { main: 600, byo: 30, periods: 3 } }, 
            captures: { black: 0, white: 0 },   
            players: { 
                black: { id: socket.id, name: data.name, avatar: data.avatar, token: data.token, isBot: false }, 
                white: { id: 'bot_id', name: botName, avatar: botAvatar, token: 'bot_token', isBot: true, botLevel: data.level } 
            }
        };

        socket.join(newRoomId);
        socket.emit('1v1_match_started', { 
            roomId: newRoomId, size: bSize, 
            playerBlack: data.name, avatarBlack: data.avatar, 
            playerWhite: botName, avatarWhite: botAvatar, 
            myColor: 'black', komi: 6.5, timers: active1v1Matches[newRoomId].timers, board: emptyBoard, turn: 'black', state: 'playing' 
        });
    });

    socket.on('create_challenge', (data) => { 
        const challengeId = 'chal_' + socket.id; 
        let parsedSize = data.boardSize === 'polar' ? 'polar' : parseInt(data.boardSize);
        challenges[challengeId] = { 
            id: challengeId, challengerId: socket.id, challengerName: data.name, challengerAvatar: data.avatar, token: data.token, 
            boardSize: parsedSize, timeSetting: data.timeSetting, handicap: parseInt(data.handicap) 
        }; 
        broadcastMatchmaking(); 
    });
    
    socket.on('cancel_challenge', () => { const challengeId = 'chal_' + socket.id; if (challenges[challengeId]) { delete challenges[challengeId]; broadcastMatchmaking(); } });

    socket.on('accept_challenge', (challengeId, acceptorData) => {
        const chal = challenges[challengeId];
        if (chal && chal.challengerId !== socket.id) { 
            const newRoomId = '1v1_' + Math.random().toString(36).substring(2,8);
            let emptyBoard;
            if(chal.boardSize === 'polar') { emptyBoard = Array(24).fill(null).map(() => Array(6).fill(null)); } 
            else { emptyBoard = Array(chal.boardSize).fill(null).map(() => Array(chal.boardSize).fill(null)); }
            
            let parts = chal.timeSetting.split('_'); let mainT = parseInt(parts[0].replace('m','')) * 60; let pCount = parseInt(parts[1]); let byoT = parseInt(parts[2]);
            let hcapStones = getHandicapStones(chal.boardSize, chal.handicap);
            hcapStones.forEach(st => emptyBoard[st.x][st.y] = 'black');
            let initialTurn = chal.handicap > 0 ? 'white' : 'black'; let initialKomi = chal.handicap > 0 ? 0.5 : 6.5;

            active1v1Matches[newRoomId] = {
                id: newRoomId, size: chal.boardSize, board: emptyBoard, turn: initialTurn, passes: 0,
                state: 'playing', komi: initialKomi, handicapStones: hcapStones, settings: { byoTime: byoT },
                deadStones: new Set(), accepts: { black: false, white: false },
                history: new Set([JSON.stringify(emptyBoard)]), moveList: [], 
                timers: { black: { main: mainT, byo: byoT, periods: pCount }, white: { main: mainT, byo: byoT, periods: pCount } }, 
                captures: { black: 0, white: 0 },   
                players: { black: { id: chal.challengerId, name: chal.challengerName, avatar: chal.challengerAvatar, token: chal.token }, white: { id: socket.id, name: acceptorData.name, avatar: acceptorData.avatar, token: acceptorData.token } }
            };

            if(currentRoom && rooms[currentRoom]) { delete rooms[currentRoom].players[socket.id]; socket.leave(currentRoom); broadcastLeaderboard(currentRoom); }
            socket.join(newRoomId); const opponentSocket = io.sockets.sockets.get(chal.challengerId); if(opponentSocket) opponentSocket.join(newRoomId);

            io.to(chal.challengerId).emit('1v1_match_started', { roomId: newRoomId, size: chal.boardSize, playerBlack: chal.challengerName, avatarBlack: chal.challengerAvatar, playerWhite: acceptorData.name, avatarWhite: acceptorData.avatar, myColor: 'black', komi: initialKomi, timers: active1v1Matches[newRoomId].timers, board: emptyBoard, turn: initialTurn, state: 'playing' });
            socket.emit('1v1_match_started', { roomId: newRoomId, size: chal.boardSize, playerBlack: chal.challengerName, avatarBlack: chal.challengerAvatar, playerWhite: acceptorData.name, avatarWhite: acceptorData.avatar, myColor: 'white', komi: initialKomi, timers: active1v1Matches[newRoomId].timers, board: emptyBoard, turn: initialTurn, state: 'playing' });
            delete challenges[challengeId]; broadcastMatchmaking();
        }
    });

    socket.on('spectate_match', (matchId) => {
        const match = active1v1Matches[matchId];
        if(match) {
            if(currentRoom && rooms[currentRoom]) { delete rooms[currentRoom].players[socket.id]; socket.leave(currentRoom); broadcastLeaderboard(currentRoom); }
            socket.join(matchId);
            socket.emit('1v1_match_started', { roomId: matchId, size: match.size, playerBlack: match.players.black.name, avatarBlack: match.players.black.avatar, playerWhite: match.players.white.name, avatarWhite: match.players.white.avatar, myColor: 'spectator', komi: match.komi, board: match.board, turn: match.turn, captures: match.captures, timers: match.timers, state: match.state, deadStones: Array.from(match.deadStones) });
        }
    });

    socket.on('1v1_make_move', (data) => {
        let success = processMove(data.roomId, socket.id, data.x, data.y, false);
        if(success) {
            let match = active1v1Matches[data.roomId];
            // Wenn der Zug erfolgreich war und der Gegner ein Bot ist -> Bot anstoßen
            if(match && match.players[match.turn].isBot) {
                triggerBotMove(data.roomId);
            }
        }
    });

    socket.on('1v1_request_undo', (matchId) => {
        let match = active1v1Matches[matchId]; if(!match || match.state !== 'playing') return;
        if(match.moveList.length === 0) return;
        let myColor = match.players.black.id === socket.id ? 'black' : 'white';
        let enemy = match.players[myColor === 'black' ? 'white' : 'black'];
        
        if (enemy.isBot) {
            socket.emit('1v1_undo_declined'); // Bot erlaubt kein Undo!
        } else {
            io.to(enemy.id).emit('1v1_undo_requested');
        }
    });

    socket.on('1v1_respond_undo', (data) => {
        let match = active1v1Matches[data.matchId]; if(!match) return;
        let myColor = match.players.black.id === socket.id ? 'black' : 'white';
        let enemyId = match.players[myColor === 'black' ? 'white' : 'black'].id;

        if(data.accept) {
            let lastMove = match.moveList.pop(); if(!lastMove) return;
            
            let emptyBoard;
            if(match.size === 'polar') { emptyBoard = Array(24).fill(null).map(() => Array(6).fill(null)); } 
            else { emptyBoard = Array(match.size).fill(null).map(() => Array(match.size).fill(null)); }
            
            match.board = emptyBoard; match.captures = {black: 0, white: 0}; match.history = new Set([JSON.stringify(emptyBoard)]);
            if(match.handicapStones) match.handicapStones.forEach(st => match.board[st.x][st.y] = 'black');

            for(let m of match.moveList) {
                if(!m.pass && m.x !== undefined && m.y !== undefined) {
                    match.board[m.x][m.y] = m.color; let enemy = m.color === 'black' ? 'white' : 'black';
                    let caps = checkCaptures(match.board, m.x, m.y, enemy, match.size);
                    caps.forEach(c => match.board[c.x][c.y] = null);
                    match.captures[m.color] += caps.length;
                }
                match.history.add(JSON.stringify(match.board));
            }
            match.turn = match.turn === 'black' ? 'white' : 'black'; match.passes = 0;
            let currentLastMove = match.moveList.length > 0 ? match.moveList[match.moveList.length-1] : null;
            io.to(data.matchId).emit('1v1_update_board', { board: match.board, turn: match.turn, lastMove: currentLastMove, captures: match.captures });
        } else { io.to(enemyId).emit('1v1_undo_declined'); }
    });

    socket.on('1v1_pass', (matchId) => {
        let success = processMove(matchId, socket.id, null, null, true);
        if(success) {
            let match = active1v1Matches[matchId];
            if(match && match.state === 'playing' && match.players[match.turn].isBot) {
                triggerBotMove(matchId);
            }
        }
    });

    socket.on('1v1_toggle_dead', (data) => {
        const matchId = data.roomId; const match = active1v1Matches[matchId];
        if(!match || match.state !== 'scoring') return;
        if(match.players.black.id !== socket.id && match.players.white.id !== socket.id) return; 
        if(match.board[data.x][data.y] === null) return; 

        let group = getGroupOfColor(match.board, data.x, data.y, match.size);
        let isDead = match.deadStones.has(`${data.x},${data.y}`);

        group.forEach(stone => {
            if(isDead) match.deadStones.delete(`${stone.x},${stone.y}`); else match.deadStones.add(`${stone.x},${stone.y}`); 
        });
        match.accepts.black = false; match.accepts.white = false;
        
        // Bots akzeptieren immer sofort alles, wenn sie im Scoring sind
        if(match.players.black.isBot) match.accepts.black = true;
        if(match.players.white.isBot) match.accepts.white = true;
        
        let scoreData = calculateJapaneseScore(match.board, match.captures, match.deadStones, match.komi, match.size);
        io.to(matchId).emit('1v1_scoring_update', { deadStones: Array.from(match.deadStones), accepts: match.accepts, scoreData: scoreData });
    });

    socket.on('1v1_accept_score', (matchId) => {
        const match = active1v1Matches[matchId]; if(!match || match.state !== 'scoring') return;
        const myColor = (match.players.black.id === socket.id) ? 'black' : 'white'; match.accepts[myColor] = true;
        
        let scoreData = calculateJapaneseScore(match.board, match.captures, match.deadStones, match.komi, match.size);
        io.to(matchId).emit('1v1_scoring_update', { deadStones: Array.from(match.deadStones), accepts: match.accepts, scoreData: scoreData });

        if(match.accepts.black && match.accepts.white) {
            let winnerColor = scoreData.blackTotal > scoreData.whiteTotal ? 'black' : 'white';
            let winnerPlayer = match.players[winnerColor]; let diff = Math.abs(scoreData.blackTotal - scoreData.whiteTotal);
            let reason = `Beide Spieler haben die Zählung akzeptiert.<br>🏆 <b>${winnerPlayer.avatar} ${winnerPlayer.name} gewinnt</b> mit ${diff} Punkten Vorsprung!<br><br><div style='font-size:1.1rem; color:#ccc; margin-top: 15px; text-align: left; background: #111; padding: 10px; border-radius: 8px;'><b>Japanische Zählung:</b><br>⚫ Schwarz: ${scoreData.blackTotal} Punkte <br><span style='font-size:0.9rem;'>(${scoreData.blackTerr} Gebiet + ${scoreData.blackCaps} Gefangene)</span><br><br>⚪ Weiß: ${scoreData.whiteTotal} Punkte <br><span style='font-size:0.9rem;'>(${scoreData.whiteTerr} Gebiet + ${scoreData.whiteCaps} Gefangene + ${match.komi} Komi)</span></div>`;
            finishMatch(matchId, winnerColor, reason);
        }
    });

    socket.on('1v1_resign', (matchId) => {
        const match = active1v1Matches[matchId]; if(!match) return;
        let loserColor = match.players.black.id === socket.id ? 'black' : 'white';
        let winnerColor = loserColor === 'black' ? 'white' : 'black'; let loser = match.players[loserColor];
        finishMatch(matchId, winnerColor, `🏳️ ${loser.avatar} ${loser.name} hat aufgegeben.`);
    });

    socket.on('join_room', (data) => {
        const playerName = data.name; const playerAvatar = data.avatar; const requestedRoom = data.roomId; currentRoom = requestedRoom; initRoom(currentRoom); socket.join(currentRoom); 
        let isHost = false; if (currentRoom !== 'public' && Object.keys(rooms[currentRoom].players).length === 0) rooms[currentRoom].hostId = socket.id;
        if (rooms[currentRoom].hostId === socket.id) isHost = true;
        rooms[currentRoom].players[socket.id] = { name: playerName, avatar: playerAvatar, score: 0, combo: 0, id: socket.id, token: data.token }; 
        socket.emit('room_joined', { roomId: currentRoom, isHost: isHost }); broadcastLeaderboard(currentRoom); 
        if (rooms[currentRoom].isPlaying) { socket.emit('game_already_started'); if (rooms[currentRoom].currentLevel < rooms[currentRoom].puzzles.length) { socket.emit('new_round', { puzzle: rooms[currentRoom].puzzles[rooms[currentRoom].currentLevel], maxTime: rooms[currentRoom].settings.timeLimit }); } }
    });
    
    socket.on('start_game', (settings) => {
        if (!currentRoom || !rooms[currentRoom]) return; let r = rooms[currentRoom]; if (currentRoom !== 'public' && r.hostId !== socket.id) return;
        if (!r.isPlaying) { let freshDeck = [...r.originalPuzzles]; shuffle(freshDeck); if (settings) { r.settings.timeLimit = parseInt(settings.timeLimit); let count = settings.puzzleCount === 'all' ? freshDeck.length : parseInt(settings.puzzleCount); r.puzzles = freshDeck.slice(0, count); } else { r.puzzles = freshDeck; } r.isPlaying = true; r.currentLevel = -1; for (let id in r.players) { r.players[id].score = 0; r.players[id].combo = 0; } broadcastLeaderboard(currentRoom); io.to(currentRoom).emit('game_starting'); setTimeout(() => nextLevel(currentRoom), 1000); }
    });

    socket.on('chat_message', (data) => { 
        let u = userDB[data.token];
        let msgData = {
            name: data.name, avatar: data.avatar, rank: data.rank, text: data.text,
            title: (u && u.equipped && u.equipped.title && SHOP_ITEMS[u.equipped.title]) ? SHOP_ITEMS[u.equipped.title].name : '',
            aura: (u && u.equipped && u.equipped.aura && SHOP_ITEMS[u.equipped.aura]) ? SHOP_ITEMS[u.equipped.aura].class : ''
        };
        let targetRoom = Array.from(socket.rooms).find(r => r !== socket.id); 
        if(targetRoom) io.to(targetRoom).emit('chat_message', msgData); 
    });

    socket.on('guess', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return; let r = rooms[currentRoom]; const p = r.puzzles[r.currentLevel]; if (!p || !r.isPlaying) return; let player = r.players[socket.id]; const isCorrect = p.solution.some(sol => sol.x === data.x && sol.y === data.y);
        if (isCorrect) { 
            player.combo += 1; let basePoints = 100 + (r.timeLeft * (100 / r.settings.timeLimit)); let comboBonus = (player.combo > 1) ? (player.combo - 1) * 50 : 0; let totalPoints = Math.round(basePoints + comboBonus); player.score += totalPoints; 
            
            if (userDB[player.token]) {
                let uDB = userDB[player.token];
                uDB.coins = (uDB.coins || 0) + 2;
                
                if(uDB.quests && uDB.quests.date === new Date().toISOString().split('T')[0]) {
                    if(uDB.quests.tsumego.current < uDB.quests.tsumego.target) uDB.quests.tsumego.current++;
                }

                addPetXp(uDB, 5, player.id);

                saveDB();
                io.to(player.id).emit('update_stats', uDB);
            }

            socket.emit('correct_guess', { points: totalPoints, combo: player.combo }); socket.to(currentRoom).emit('round_won_by_other', { winnerName: player.name, x: data.x, y: data.y }); for (let id in r.players) { if (id !== socket.id) r.players[id].combo = 0; } broadcastLeaderboard(currentRoom); nextLevel(currentRoom); 
        } else { player.combo = 0; socket.emit('wrong_guess'); }
    });

    socket.on('disconnect', () => {
        if(socket.userToken && activeSessions[socket.userToken] === socket.id) {
            delete activeSessions[socket.userToken];
        }

        const chalId = 'chal_' + socket.id; if (challenges[chalId]) { delete challenges[chalId]; broadcastMatchmaking(); }
        
        for(let mId in active1v1Matches) {
            let m = active1v1Matches[mId];
            let dcColor = null;
            if(m.players.black.id === socket.id && !m.players.black.isBot) dcColor = 'black';
            else if(m.players.white.id === socket.id && !m.players.white.isBot) dcColor = 'white';
            
            if(dcColor) {
                m.dcTimers = m.dcTimers || {};
                m.dcTimers[dcColor] = setTimeout(() => {
                    let winnerColor = dcColor === 'black' ? 'white' : 'black';
                    finishMatch(mId, winnerColor, `⏳ Gegner hat die Verbindung verloren (Timeout).`);
                }, 60000); 
                io.to(mId).emit('1v1_opponent_disconnected', { color: dcColor });
            }
        }

        if(currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) { delete rooms[currentRoom].players[socket.id]; broadcastLeaderboard(currentRoom); const remainingPlayers = Object.keys(rooms[currentRoom].players); if (currentRoom !== 'public' && remainingPlayers.length === 0) { clearInterval(rooms[currentRoom].interval); delete rooms[currentRoom]; } else if (currentRoom !== 'public' && rooms[currentRoom].hostId === socket.id) { rooms[currentRoom].hostId = remainingPlayers[0]; io.to(remainingPlayers[0]).emit('you_are_host'); } }
    });
});

function nextLevel(roomId) { let r = rooms[roomId]; if (!r) return; clearInterval(r.interval); r.currentLevel++; if (r.currentLevel >= r.puzzles.length) { const finalLeaderboard = Object.values(r.players).sort((a, b) => b.score - a.score); io.to(roomId).emit('game_over', finalLeaderboard); r.isPlaying = false; return; } setTimeout(() => startRound(roomId), 3500); }
function startRound(roomId) { let r = rooms[roomId]; if (!r) return; r.timeLeft = r.settings.timeLimit; io.to(roomId).emit('new_round', { puzzle: r.puzzles[r.currentLevel], maxTime: r.settings.timeLimit }); clearInterval(r.interval); r.interval = setInterval(() => { r.timeLeft--; io.to(roomId).emit('timer', r.timeLeft); if (r.timeLeft <= 0) { clearInterval(r.interval); for (let id in r.players) r.players[id].combo = 0; io.to(roomId).emit('timeout', r.puzzles[r.currentLevel].solution); nextLevel(roomId); } }, 1000); }

http.listen(3000, () => { console.log('🚀 Server läuft auf Port 3000'); });