// --- server.js ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs'); 
const path = require('path'); 

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- SGF-Übersetzer ---
function parseSGF(sgfString, msg, solutionsArray) {
    const setup = [];
    const cleanSgf = sgfString.replace(/\s+/g, ''); 
    const blackMatch = cleanSgf.match(/AB(\[[a-zA-Z]{2}\])+/g);
    if (blackMatch) {
        blackMatch.forEach(block => {
            const points = block.replace('AB', '').match(/[a-zA-Z]{2}/g);
            if (points) points.forEach(pt => setup.push({ x: pt.toLowerCase().charCodeAt(0) - 97, y: pt.toLowerCase().charCodeAt(1) - 97, c: "black" }));
        });
    }
    const whiteMatch = cleanSgf.match(/AW(\[[a-zA-Z]{2}\])+/g);
    if (whiteMatch) {
        whiteMatch.forEach(block => {
            const points = block.replace('AW', '').match(/[a-zA-Z]{2}/g);
            if (points) points.forEach(pt => setup.push({ x: pt.toLowerCase().charCodeAt(0) - 97, y: pt.toLowerCase().charCodeAt(1) - 97, c: "white" }));
        });
    }
    const solutionCoords = solutionsArray.map(sol => ({ x: sol.toLowerCase().charCodeAt(0) - 97, y: sol.toLowerCase().charCodeAt(1) - 97 }));
    return { msg: msg, setup: setup, solution: solutionCoords };
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

let globalPuzzles = [];
function loadPuzzles() {
    globalPuzzles = [];
    const puzzlesDir = path.join(__dirname, 'puzzles');
    if (!fs.existsSync(puzzlesDir)) fs.mkdirSync(puzzlesDir);
    const files = fs.readdirSync(puzzlesDir).filter(f => f.endsWith('.sgf'));
    files.forEach(file => {
        const content = fs.readFileSync(path.join(puzzlesDir, file), 'utf-8');
        const sgfParts = content.split(/(?<=\))\s*(?=\()/); 
        sgfParts.forEach((part, index) => {
            const cleanPart = part.trim();
            if (cleanPart.length < 10) return; 
            let msg = file.replace('.sgf', '').replace(/_/g, ' '); 
            if (sgfParts.length > 1) msg += ` (#${index + 1})`;
            const firstMoveMatch = cleanPart.match(/;[BW]\[([a-zA-Z]{2})\]/);
            if (firstMoveMatch) {
                let solutions = [firstMoveMatch[1]]; 
                const altMatches = cleanPart.match(/\(\s*;[BW]\[([a-zA-Z]{2})\]/g);
                if (altMatches) altMatches.forEach(m => solutions.push(m.match(/\[([a-zA-Z]{2})\]/)[1])); 
                solutions = [...new Set(solutions)];
                const setupPart = cleanPart.split(/;[BW]\[/)[0] + ")";
                const parsedPuzzle = parseSGF(setupPart, msg, solutions);
                if (parsedPuzzle.setup.length > 0) globalPuzzles.push(parsedPuzzle);
            }
        });
    });
    if (globalPuzzles.length === 0) globalPuzzles.push(parseSGF("(;GM[1]FF[4]SZ[19]AB[dd]AW[pp];B[qq])", "Fallback", ["qq"]));
    console.log(`🚀 BEREIT: ${globalPuzzles.length} Level in der Datenbank!`);
}
loadPuzzles();

// --- ECHTE GO ENGINE ---
function checkCaptures(board, x, y, colorTarget) {
    let captured = []; let visited = new Set();
    function getGroup(gx, gy) {
        let group = []; let liberties = 0; let queue = [{x: gx, y: gy}];
        visited.add(`${gx},${gy}`);
        while(queue.length > 0) {
            let curr = queue.shift(); group.push(curr);
            const neighbors = [ {x: curr.x+1, y: curr.y}, {x: curr.x-1, y: curr.y}, {x: curr.x, y: curr.y+1}, {x: curr.x, y: curr.y-1} ];
            for(let n of neighbors) {
                if(n.x >= 0 && n.x < board.length && n.y >= 0 && n.y < board.length) {
                    let neighborState = board[n.x][n.y];
                    if(neighborState === null) liberties++;
                    else if(neighborState === colorTarget && !visited.has(`${n.x},${n.y}`)) { visited.add(`${n.x},${n.y}`); queue.push(n); }
                }
            }
        }
        return {group, liberties};
    }

    const neighbors = [ {x: x+1, y: y}, {x: x-1, y: y}, {x: x, y: y+1}, {x: x, y: y-1} ];
    for(let n of neighbors) {
        if(n.x >= 0 && n.x < board.length && n.y >= 0 && n.y < board.length) {
            if(board[n.x][n.y] === colorTarget && !visited.has(`${n.x},${n.y}`)) {
                let {group, liberties} = getGroup(n.x, n.y);
                if(liberties === 0) group.forEach(stone => captured.push(stone));
            }
        }
    }
    return captured;
}

function getGroupOfColor(board, startX, startY) {
    let color = board[startX][startY];
    if (!color) return [];
    let group = []; let visited = new Set(); let queue = [{x: startX, y: startY}];
    visited.add(`${startX},${startY}`);

    while(queue.length > 0) {
        let curr = queue.shift(); group.push(curr);
        let neighbors = [ {x: curr.x+1, y: curr.y}, {x: curr.x-1, y: curr.y}, {x: curr.x, y: curr.y+1}, {x: curr.x, y: curr.y-1} ];
        for(let n of neighbors) {
            if(n.x >= 0 && n.x < board.length && n.y >= 0 && n.y < board.length) {
                if(board[n.x][n.y] === color && !visited.has(`${n.x},${n.y}`)) {
                    visited.add(`${n.x},${n.y}`);
                    queue.push(n);
                }
            }
        }
    }
    return group;
}

function calculateJapaneseScore(board, captures, deadStonesSet) {
    let size = board.length;
    let blackTerritory = 0;
    let whiteTerritory = 0;
    let finalCaptures = { black: captures.black, white: captures.white };

    let scoreBoard = board.map(row => [...row]);
    deadStonesSet.forEach(pos => {
        let [x, y] = pos.split(',').map(Number);
        let color = scoreBoard[x][y];
        if (color === 'black') finalCaptures.white++; 
        if (color === 'white') finalCaptures.black++; 
        scoreBoard[x][y] = null; 
    });

    let visited = Array(size).fill(0).map(() => Array(size).fill(false));
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (scoreBoard[x][y] === null && !visited[x][y]) {
                let queue = [{x, y}];
                visited[x][y] = true;
                let touchesBlack = false;
                let touchesWhite = false;
                let emptyCount = 0;

                while (queue.length > 0) {
                    let curr = queue.shift();
                    emptyCount++;
                    let neighbors = [ {x: curr.x+1, y: curr.y}, {x: curr.x-1, y: curr.y}, {x: curr.x, y: curr.y+1}, {x: curr.x, y: curr.y-1} ];
                    for (let n of neighbors) {
                        if (n.x >= 0 && n.x < size && n.y >= 0 && n.y < size) {
                            if (scoreBoard[n.x][n.y] === 'black') touchesBlack = true;
                            else if (scoreBoard[n.x][n.y] === 'white') touchesWhite = true;
                            else if (!visited[n.x][n.y]) {
                                visited[n.x][n.y] = true;
                                queue.push(n);
                            }
                        }
                    }
                }
                if (touchesBlack && !touchesWhite) blackTerritory += emptyCount;
                if (touchesWhite && !touchesBlack) whiteTerritory += emptyCount;
            }
        }
    }
    
    return { 
        blackTotal: blackTerritory + finalCaptures.black, 
        whiteTotal: whiteTerritory + finalCaptures.white + 6.5,
        blackTerr: blackTerritory, whiteTerr: whiteTerritory,
        blackCaps: finalCaptures.black, whiteCaps: finalCaptures.white
    };
}


// --- MULTIPLAYER HOTEL ---
const rooms = {};
const challenges = {}; 
const active1v1Matches = {}; 

function initRoom(roomId) {
    if (!rooms[roomId]) {
        let roomPuzzles = [...globalPuzzles]; shuffle(roomPuzzles);
        rooms[roomId] = { id: roomId, players: {}, isPlaying: false, currentLevel: 0, hostId: null, settings: { timeLimit: 10, puzzleCount: roomPuzzles.length }, interval: null, puzzles: roomPuzzles, originalPuzzles: roomPuzzles };
    }
}
initRoom('public');

function broadcastLeaderboard(roomId) {
    if (!rooms[roomId]) return;
    const sortedPlayers = Object.values(rooms[roomId].players).sort((a, b) => b.score - a.score);  
    io.to(roomId).emit('update_leaderboard', sortedPlayers); 
}

setInterval(() => {
    for (let matchId in active1v1Matches) {
        let match = active1v1Matches[matchId];
        if (match.state === 'playing') {
            match.timers[match.turn]--; 
            io.to(matchId).emit('1v1_timer_update', { timers: match.timers, turn: match.turn });

            if (match.timers[match.turn] <= 0) {
                let winner = match.players[match.turn === 'black' ? 'white' : 'black'];
                io.to(matchId).emit('1v1_game_over', { reason: `⏱️ Zeit abgelaufen! ${winner.avatar} ${winner.name} gewinnt.` });
                delete active1v1Matches[matchId];
            }
        }
    }
}, 1000);

io.on('connection', (socket) => {
    let currentRoom = null; 

    // --- NEU: Avatare werden jetzt überall mitgespeichert! ---

    socket.on('request_challenges', () => { socket.emit('update_challenges', Object.values(challenges)); });
    
    socket.on('create_challenge', (data) => { 
        const challengeId = 'chal_' + socket.id; 
        challenges[challengeId] = { id: challengeId, challengerId: socket.id, challengerName: data.name, challengerAvatar: data.avatar, boardSize: parseInt(data.boardSize) }; 
        io.emit('update_challenges', Object.values(challenges)); 
    });
    
    socket.on('cancel_challenge', () => { const challengeId = 'chal_' + socket.id; if (challenges[challengeId]) { delete challenges[challengeId]; io.emit('update_challenges', Object.values(challenges)); } });

    socket.on('accept_challenge', (challengeId, acceptorData) => {
        const chal = challenges[challengeId];
        if (chal && chal.challengerId !== socket.id) { 
            const newRoomId = '1v1_' + Math.random().toString(36).substring(2,8);
            let emptyBoard = Array(chal.boardSize).fill(null).map(() => Array(chal.boardSize).fill(null));
            
            active1v1Matches[newRoomId] = {
                id: newRoomId, size: chal.boardSize, board: emptyBoard, turn: 'black', passes: 0,
                state: 'playing', 
                deadStones: new Set(),
                accepts: { black: false, white: false },
                history: new Set([JSON.stringify(emptyBoard)]),
                timers: { black: 600, white: 600 }, 
                captures: { black: 0, white: 0 },   
                players: { 
                    black: { id: chal.challengerId, name: chal.challengerName, avatar: chal.challengerAvatar }, 
                    white: { id: socket.id, name: acceptorData.name, avatar: acceptorData.avatar } 
                }
            };

            if(currentRoom && rooms[currentRoom]) { delete rooms[currentRoom].players[socket.id]; socket.leave(currentRoom); broadcastLeaderboard(currentRoom); }
            socket.join(newRoomId);
            const opponentSocket = io.sockets.sockets.get(chal.challengerId);
            if(opponentSocket) opponentSocket.join(newRoomId);

            io.to(chal.challengerId).emit('1v1_match_started', { roomId: newRoomId, size: chal.boardSize, playerBlack: chal.challengerName, avatarBlack: chal.challengerAvatar, playerWhite: acceptorData.name, avatarWhite: acceptorData.avatar, myColor: 'black' });
            socket.emit('1v1_match_started', { roomId: newRoomId, size: chal.boardSize, playerBlack: chal.challengerName, avatarBlack: chal.challengerAvatar, playerWhite: acceptorData.name, avatarWhite: acceptorData.avatar, myColor: 'white' });
            
            delete challenges[challengeId]; io.emit('update_challenges', Object.values(challenges));
        }
    });

    socket.on('1v1_make_move', (data) => {
        const matchId = data.roomId; const match = active1v1Matches[matchId];
        if(!match || match.state !== 'playing') return;

        const myColor = (match.players.black.id === socket.id) ? 'black' : 'white';
        if(match.turn !== myColor) return;
        if(match.board[data.x][data.y] !== null) return;

        let newBoard = match.board.map(row => [...row]);
        newBoard[data.x][data.y] = myColor;

        const enemyColor = (myColor === 'black') ? 'white' : 'black';
        let capturedStones = checkCaptures(newBoard, data.x, data.y, enemyColor);
        capturedStones.forEach(stone => { newBoard[stone.x][stone.y] = null; });

        let suicideCheck = checkCaptures(newBoard, data.x, data.y, myColor);
        if(suicideCheck.length > 0 && capturedStones.length === 0) { socket.emit('1v1_illegal_move', "Selbstmord ist nicht erlaubt!"); return; }

        let boardString = JSON.stringify(newBoard);
        if(match.history.has(boardString)) { socket.emit('1v1_illegal_move', "Ko-Regel: Diese Stellung gab es gerade schon!"); return; }

        match.captures[myColor] += capturedStones.length;
        match.board = newBoard; match.history.add(boardString); match.turn = enemyColor; match.passes = 0;
        
        io.to(matchId).emit('1v1_update_board', { board: match.board, turn: match.turn, lastMove: {x: data.x, y: data.y}, captures: match.captures });
    });

    socket.on('1v1_pass', (matchId) => {
        const match = active1v1Matches[matchId];
        if(!match || match.state !== 'playing') return;
        const myColor = (match.players.black.id === socket.id) ? 'black' : 'white';
        if(match.turn !== myColor) return;

        match.passes++;
        match.turn = (myColor === 'black') ? 'white' : 'black';

        if(match.passes >= 2) {
            match.state = 'scoring';
            io.to(matchId).emit('1v1_scoring_phase');
        } else {
            io.to(matchId).emit('1v1_update_board', { board: match.board, turn: match.turn, lastMove: null, captures: match.captures });
        }
    });

    socket.on('1v1_toggle_dead', (data) => {
        const matchId = data.roomId; const match = active1v1Matches[matchId];
        if(!match || match.state !== 'scoring') return;
        if(match.board[data.x][data.y] === null) return; 

        let group = getGroupOfColor(match.board, data.x, data.y);
        let isDead = match.deadStones.has(`${data.x},${data.y}`);

        group.forEach(stone => {
            if(isDead) match.deadStones.delete(`${stone.x},${stone.y}`); 
            else match.deadStones.add(`${stone.x},${stone.y}`); 
        });

        match.accepts.black = false; match.accepts.white = false;
        io.to(matchId).emit('1v1_scoring_update', { deadStones: Array.from(match.deadStones), accepts: match.accepts });
    });

    socket.on('1v1_accept_score', (matchId) => {
        const match = active1v1Matches[matchId];
        if(!match || match.state !== 'scoring') return;
        
        const myColor = (match.players.black.id === socket.id) ? 'black' : 'white';
        match.accepts[myColor] = true;

        io.to(matchId).emit('1v1_scoring_update', { deadStones: Array.from(match.deadStones), accepts: match.accepts });

        if(match.accepts.black && match.accepts.white) {
            let finalScore = calculateJapaneseScore(match.board, match.captures, match.deadStones);
            let winnerPlayer = finalScore.blackTotal > finalScore.whiteTotal ? match.players.black : match.players.white;
            let diff = Math.abs(finalScore.blackTotal - finalScore.whiteTotal);
            
            io.to(matchId).emit('1v1_game_over', { 
                reason: `Beide Spieler haben die Zählung akzeptiert.<br>🏆 <b>${winnerPlayer.avatar} ${winnerPlayer.name} gewinnt</b> mit ${diff} Punkten Vorsprung!<br><br>
                <div style='font-size:1.1rem; color:#ccc; margin-top: 15px; text-align: left; background: #111; padding: 10px; border-radius: 8px;'>
                <b>Japanische Zählung:</b><br>
                ⚫ Schwarz: ${finalScore.blackTotal} Punkte <br><span style='font-size:0.9rem;'>(${finalScore.blackTerr} Gebiet + ${finalScore.blackCaps} Gefangene)</span><br><br>
                ⚪ Weiß: ${finalScore.whiteTotal} Punkte <br><span style='font-size:0.9rem;'>(${finalScore.whiteTerr} Gebiet + ${finalScore.whiteCaps} Gefangene + 6.5 Komi)</span>
                </div>`
            });
            delete active1v1Matches[matchId];
        }
    });

    socket.on('1v1_resign', (matchId) => {
        const match = active1v1Matches[matchId]; if(!match) return;
        const loser = (match.players.black.id === socket.id) ? match.players.black : match.players.white;
        io.to(matchId).emit('1v1_game_over', { reason: `🏳️ ${loser.avatar} ${loser.name} hat aufgegeben.` });
        delete active1v1Matches[matchId];
    });

    // --- TSUMEGO RUSH LOGIK ---
    socket.on('join_room', (data) => {
        const playerName = data.name; const playerAvatar = data.avatar; const requestedRoom = data.roomId; 
        currentRoom = requestedRoom; initRoom(currentRoom); socket.join(currentRoom); 
        let isHost = false; if (currentRoom !== 'public' && Object.keys(rooms[currentRoom].players).length === 0) rooms[currentRoom].hostId = socket.id;
        if (rooms[currentRoom].hostId === socket.id) isHost = true;
        // Speichere den Avatar mit ab!
        rooms[currentRoom].players[socket.id] = { name: playerName, avatar: playerAvatar, score: 0, combo: 0, id: socket.id }; 
        socket.emit('room_joined', { roomId: currentRoom, isHost: isHost }); broadcastLeaderboard(currentRoom); 
        if (rooms[currentRoom].isPlaying) { socket.emit('game_already_started'); if (rooms[currentRoom].currentLevel < rooms[currentRoom].puzzles.length) { socket.emit('new_round', { puzzle: rooms[currentRoom].puzzles[rooms[currentRoom].currentLevel], maxTime: rooms[currentRoom].settings.timeLimit }); } }
    });
    
    socket.on('start_game', (settings) => {
        if (!currentRoom || !rooms[currentRoom]) return; let r = rooms[currentRoom]; if (currentRoom !== 'public' && r.hostId !== socket.id) return;
        if (!r.isPlaying) { let freshDeck = [...r.originalPuzzles]; shuffle(freshDeck); if (settings) { r.settings.timeLimit = parseInt(settings.timeLimit); let count = settings.puzzleCount === 'all' ? freshDeck.length : parseInt(settings.puzzleCount); r.puzzles = freshDeck.slice(0, count); } else { r.puzzles = freshDeck; } r.isPlaying = true; r.currentLevel = -1; for (let id in r.players) { r.players[id].score = 0; r.players[id].combo = 0; } broadcastLeaderboard(currentRoom); io.to(currentRoom).emit('game_starting'); setTimeout(() => nextLevel(currentRoom), 1000); }
    });

    // NEU: Nimmt Name UND Avatar direkt vom Client für den Chat
    socket.on('chat_message', (data) => { 
        let targetRoom = Array.from(socket.rooms).find(r => r !== socket.id);
        if(targetRoom) io.to(targetRoom).emit('chat_message', data);
    });

    socket.on('guess', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return; let r = rooms[currentRoom]; const p = r.puzzles[r.currentLevel]; if (!p || !r.isPlaying) return; let player = r.players[socket.id]; const isCorrect = p.solution.some(sol => sol.x === data.x && sol.y === data.y);
        if (isCorrect) { player.combo += 1; let basePoints = 100 + (r.timeLeft * (100 / r.settings.timeLimit)); let comboBonus = (player.combo > 1) ? (player.combo - 1) * 50 : 0; let totalPoints = Math.round(basePoints + comboBonus); player.score += totalPoints; socket.emit('correct_guess', { points: totalPoints, combo: player.combo }); socket.to(currentRoom).emit('round_won_by_other', { winnerName: player.name, x: data.x, y: data.y }); for (let id in r.players) { if (id !== socket.id) r.players[id].combo = 0; } broadcastLeaderboard(currentRoom); nextLevel(currentRoom); } 
        else { player.combo = 0; socket.emit('wrong_guess'); }
    });

    socket.on('disconnect', () => {
        const chalId = 'chal_' + socket.id; if (challenges[chalId]) { delete challenges[chalId]; io.emit('update_challenges', Object.values(challenges)); }
        if(currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) { delete rooms[currentRoom].players[socket.id]; broadcastLeaderboard(currentRoom); const remainingPlayers = Object.keys(rooms[currentRoom].players); if (currentRoom !== 'public' && remainingPlayers.length === 0) { clearInterval(rooms[currentRoom].interval); delete rooms[currentRoom]; } else if (currentRoom !== 'public' && rooms[currentRoom].hostId === socket.id) { rooms[currentRoom].hostId = remainingPlayers[0]; io.to(remainingPlayers[0]).emit('you_are_host'); } }
    });
});

function nextLevel(roomId) { let r = rooms[roomId]; if (!r) return; clearInterval(r.interval); r.currentLevel++; if (r.currentLevel >= r.puzzles.length) { const finalLeaderboard = Object.values(r.players).sort((a, b) => b.score - a.score); io.to(roomId).emit('game_over', finalLeaderboard); r.isPlaying = false; return; } setTimeout(() => startRound(roomId), 3500); }
function startRound(roomId) { let r = rooms[roomId]; if (!r) return; r.timeLeft = r.settings.timeLimit; io.to(roomId).emit('new_round', { puzzle: r.puzzles[r.currentLevel], maxTime: r.settings.timeLimit }); clearInterval(r.interval); r.interval = setInterval(() => { r.timeLeft--; io.to(roomId).emit('timer', r.timeLeft); if (r.timeLeft <= 0) { clearInterval(r.interval); for (let id in r.players) r.players[id].combo = 0; io.to(roomId).emit('timeout', r.puzzles[r.currentLevel].solution); nextLevel(roomId); } }, 1000); }

http.listen(3000, () => { console.log('🚀 Server läuft auf Port 3000'); });