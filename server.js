"use strict";

const port = process.env.PORT || 3000
const compression = require('compression');
const express = require('express'); 
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const cookieParser = require('cookie-parser');
const uuidv1 = require('uuid/v1');

const constants = require('./public/js/constants'); 
const ConnectionModule = require('./Connection');
const Connections = ConnectionModule.Connections;
const Session = require('./Session');

app.use(compression());
app.use(cookieParser()); 

function shortguid() {
	function s4() {
		return Math.floor((1 + Math.random()) * 0x10000)
		  .toString(16)
		  .substring(1);
	}
	return s4() + s4() + s4();
}

let Sessions = {};

function getPublicSessions() {
	let publicSessions = [];
	for(let s in Sessions) {
		if(Sessions[s].isPublic) {
			publicSessions.push(s);
		}
	}
	return publicSessions;
}

// Setup all websocket responses on client connection
io.on('connection', function(socket) {
	const query = socket.handshake.query;
	console.log(`${query.userName} [${query.userID}] connected. (${Object.keys(Connections).length + 1} players online)`);
	if(query.userID in Connections) {
		console.log(`${query.userName} [${query.userID}] already connected.`);
		query.userID = uuidv1();
		console.warn(`${query.userName} is now ${query.userID}.`);
		socket.emit('alreadyConnected', query.userID);
	}
	
	socket.userID = query.userID;
	Connections[query.userID] = new ConnectionModule.Connection(socket, query.userID, query.userName);
	
	// Messages
	
	socket.on('disconnect', function() {
		let userID = this.userID;
		if(userID in Connections) {
			console.log(`${Connections[userID].userName} [${userID}] disconnected. (${Object.keys(Connections).length - 1} players online)`);
			removeUserFromSession(userID);
			delete Connections[userID];
		}
	});
	
	// Personnal options
	
	socket.on('setUserName', function(userName) {
		let userID = this.userID;
		let sessionID = Connections[userID].sessionID;
		
		Connections[userID].userName = userName;
		for(let user of Sessions[sessionID].users) {
			Connections[user].socket.emit('updateUser', {
				userID: userID,
				updatedProperties: {
					userName: userName
				}
			});
		}
	});

	socket.on('setSession', function(sessionID) {
		let userID = this.userID;
		
		if(sessionID == Connections[userID].sessionID)
			return;
		
		joinSession(sessionID, userID);
	});
	
	socket.on('setCollection', function(collection) {
		let userID = this.userID;
		let sessionID = Connections[userID].sessionID;
		
		if(typeof collection !== 'object' || collection === null)
			return;
		
		Connections[userID].collection = collection;
		for(let user of Sessions[sessionID].users) {
			Connections[user].socket.emit('updateUser', {
				userID: userID,
				updatedProperties: {
					collection: collection
				}
			});
		}
	});
	
	socket.on('useCollection', function(useCollection) {
		let userID = this.userID;
		let sessionID = Connections[userID].sessionID;
		
		if(typeof useCollection !== 'boolean')
			return;

		if(useCollection == Connections[userID].useCollection)
			return;
		
		Connections[userID].useCollection = useCollection;
		for(let user of Sessions[sessionID].users) {
			Connections[user].socket.emit('updateUser', {
				userID: userID,
				updatedProperties: {
					useCollection: useCollection
				}
			});
		}
	});
	
	socket.on('chatMessage', function(message) {
		let sessionID = Connections[this.userID].sessionID;
		
		// Limits chat message length
		message.text = message.text.substring(0, Math.min(255, message.text.length));
		
		for(let user of Sessions[sessionID].users) {
			Connections[user].socket.emit('chatMessage', message);
		}
	});
	
	socket.on('startDraft', function() {
		let userID = this.userID;
		let sessionID = Connections[userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(Sessions[sessionID].drafting)
			return;
				
		if(Sessions[sessionID].users.size + Sessions[sessionID].bots >= 2) {
			Sessions[sessionID].startDraft();
		} else {
			Connections[userID].socket.emit('message', {title: `Not enough players`, text: `Can't start draft: Not enough players (min. 2 including bots).`});
		}
	});
	
	// Removes picked card from corresponding booster and notify other players.
	// Moves to next round when each player have picked a card.
	socket.on('pickCard', function(boosterIndex, cardID) {
		let userID = this.userID;
		let sessionID = Connections[userID].sessionID;
		
		if(!(sessionID in Sessions) || 
		   !(userID in Connections) || 
		   boosterIndex > Sessions[sessionID].boosters.length)
			return;
		
		console.log(`Session ${sessionID}: ${Connections[userID].userName} [${userID}] picked card ${cardID} from booster n°${boosterIndex}.`);
		
		Connections[userID].pickedCards.push(cardID);
		Connections[userID].pickedThisRound = true;
		// Removes the first occurence of cardID
		for(let i = 0; i < Sessions[sessionID].boosters[boosterIndex].length; ++i) {
			if(Sessions[sessionID].boosters[boosterIndex][i] == cardID) {
				Sessions[sessionID].boosters[boosterIndex].splice(i, 1);
				break;
			}
		}
		
		// Signal users
		for(let user of Sessions[sessionID].users) {
			Connections[user].socket.emit('updateUser', {
				userID: userID,
				updatedProperties: {
					pickedThisRound: true
				}
			});
		}
		
		++Sessions[sessionID].pickedCardsThisRound;
		if(Sessions[sessionID].pickedCardsThisRound == Sessions[sessionID].getHumanPlayerCount()) {
			Sessions[sessionID].nextBooster();
		}
	});
	
	// Session options
	
	socket.on('setSessionOwner', function(newOwnerID) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(newOwnerID === Sessions[sessionID].owner || !Sessions[sessionID].users.has(newOwnerID))
			return;
		
		Sessions[sessionID].owner = newOwnerID;
		for(let user of Sessions[sessionID].users)
			Connections[user].socket.emit('sessionOwner', Sessions[sessionID].owner);
	});
	
	socket.on('removePlayer', function(userID) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(userID === Sessions[sessionID].owner || !Sessions[sessionID].users.has(userID))
			return;
		
		removeUserFromSession(userID);
		Sessions[sessionID].replaceDisconnectedPlayers();
		Sessions[sessionID].notifyUserChange();
		
		let newSession = shortguid();
		joinSession(newSession, userID);
		Connections[userID].socket.emit('setSession', newSession);
		Connections[userID].socket.emit('message', {title: 'Removed from session', text: `You've been removed from session '${sessionID}' by its owner.`});
	});
	
	socket.on('boostersPerPlayer', function(boostersPerPlayer) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(!Number.isInteger(boostersPerPlayer))
			boostersPerPlayer = parseInt(boostersPerPlayer);
		if(!Number.isInteger(boostersPerPlayer))
			return;

		if(boostersPerPlayer == Sessions[sessionID].boostersPerPlayer)
			return;
		
		Sessions[sessionID].boostersPerPlayer = boostersPerPlayer;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('boostersPerPlayer', boostersPerPlayer);
		}
	});
	
	socket.on('bots', function(bots) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(!Number.isInteger(bots))
			bots = parseInt(bots);
		if(!Number.isInteger(bots))
			return;

		if(bots == Sessions[sessionID].bots)
			return;
		
		Sessions[sessionID].bots = bots;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('bots', bots);
		}
	});
	
	socket.on('setRestriction', function(setRestriction) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(!Array.isArray(setRestriction))
			return;
		
		if(setRestriction.length > 0) {
			for(let s of setRestriction) {
				if(constants.MTGSets.indexOf(s) === -1)
					return;
			}
		}

		if(setRestriction === Sessions[sessionID].setRestriction)
			return;
		
		Sessions[sessionID].setRestriction = setRestriction;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('setRestriction', setRestriction);
		}
	});
	
	socket.on('customCardList', function(customCardList) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(!Array.isArray(customCardList))
			return;
		Sessions[sessionID].customCardList = customCardList;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('sessionOptions', {customCardList : customCardList});
		}
	});
	
	socket.on('ignoreCollections', function(ignoreCollections) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		Sessions[sessionID].ignoreCollections = ignoreCollections;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('ignoreCollections', Sessions[sessionID].ignoreCollections);
		}
	});

	socket.on('setPickTimer', function(timerValue) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(!Number.isInteger(timerValue))
			timerValue = parseInt(timerValue);
		if(!Number.isInteger(timerValue) || timerValue < 0)
			return;
		
		Sessions[sessionID].maxTimer = timerValue;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('setPickTimer', timerValue);
		}
	});

	socket.on('setMaxPlayers', function(maxPlayers) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(!Number.isInteger(maxPlayers))
			maxPlayers = parseInt(maxPlayers);
		if(!Number.isInteger(maxPlayers) || maxPlayers < 0)
			return;
		
		Sessions[sessionID].maxPlayers = maxPlayers;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('setMaxPlayers', maxPlayers);
		}
	});

	socket.on('setMaxRarity', function(maxRarity) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		if(typeof maxRarity !== 'string')
			return;
		maxRarity = maxRarity.toLowerCase();
		if(!['mythic', 'rare', 'uncommon', 'common'].includes(maxRarity))
			return;
		Sessions[sessionID].maxRarity = maxRarity;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('setMaxRarity', maxRarity);
		}
	});
	
	socket.on('setColorBalance', function(colorBalance) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(colorBalance == Sessions[sessionID].colorBalance)
			return;
		
		Sessions[sessionID].colorBalance = colorBalance;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('sessionOptions', {colorBalance: Sessions[sessionID].colorBalance});
		}
	});
	
	socket.on('setUseCustomCardList', function(useCustomCardList) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(useCustomCardList == Sessions[sessionID].useCustomCardList)
			return;
		
		Sessions[sessionID].useCustomCardList = useCustomCardList;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('sessionOptions', {useCustomCardList: Sessions[sessionID].useCustomCardList});
		}
	});
	
	socket.on('setPublic', function(isPublic) {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(isPublic == Sessions[sessionID].isPublic)
			return;
		
		Sessions[sessionID].isPublic = isPublic;
		for(let user of Sessions[sessionID].users) {
			if(user != this.userID)
				Connections[user].socket.emit('isPublic', Sessions[sessionID].isPublic);
		}
		// Update all clients
		io.emit('publicSessions', getPublicSessions());
	});
	
	socket.on('replaceDisconnectedPlayers', function() {
		let sessionID = Connections[this.userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		Sessions[sessionID].replaceDisconnectedPlayers();
	});
	
	socket.on('distributeSealed', function(boostersPerPlayer) {
		let userID = this.userID;
		let sessionID = Connections[userID].sessionID;
		if(Sessions[sessionID].owner != this.userID)
			return;
		
		if(isNaN(boostersPerPlayer))
			return;
		
		Sessions[sessionID].emitMessage('Distributing sealed boosters...', '', false, 0);
		
		for(let user of Sessions[sessionID].users) {
			if(!Sessions[sessionID].generateBoosters(boostersPerPlayer)) {
				return;
			}
			Connections[user].socket.emit('setCardSelection', Sessions[sessionID].boosters);
		}
		Sessions[sessionID].boosters = [];
	});
	
	joinSession(query.sessionID, query.userID);
	socket.emit('publicSessions', getPublicSessions());
});

///////////////////////////////////////////////////////////////////////////////

function getUserID(req, res) {
	if(!req.cookies.userID) {
		let ID = uuidv1();
		res.cookie("userID", ID);
		return ID;
	} else {
		return req.cookies.userID;
	}
}

function joinSession(sessionID, userID) {
	// Session exists and is drafting
	if(sessionID in Sessions && Sessions[sessionID].drafting) {
		console.log(`${userID} wants to join drafting session...`);
		let sess = Sessions[sessionID];
		console.debug(sess.disconnectedUsers);
		if(userID in sess.disconnectedUsers) {
			sess.reconnectUser(userID);
		} else {
			Connections[userID].socket.emit('message', {title: 'Cannot join session', text: `This session (${sessionID}) is currently drafting. Please wait for them to finish.`});
			// Fallback to previous session if possible, or generate a new one
			if(Connections[userID].sessionID === null)
				sessionID = shortguid();
			else
				sessionID = Connections[userID].sessionID;
			Connections[userID].socket.emit('setSession', sessionID);
			//joinSession(sessionID, userID);
		}
	// Session exists and is full
	} else if(sessionID in Sessions && Sessions[sessionID].getHumanPlayerCount() >= Sessions[sessionID].maxPlayers) {
		Connections[userID].socket.emit('message', {title: 'Cannot join session', text: `This session (${sessionID}) is full (${Sessions[sessionID].users.size}/${Sessions[sessionID].maxPlayers} players).`});
		if(Connections[userID].sessionID === null)
			sessionID = shortguid();
		else
			sessionID = Connections[userID].sessionID;
		Connections[userID].socket.emit('setSession', sessionID);
		//joinSession(sessionID, userID);
	} else {
		addUserToSession(userID, sessionID);
	}
}

function addUserToSession(userID, sessionID) {
	if(Connections[userID].sessionID !== null)
		removeUserFromSession(userID);
	if(!(sessionID in Sessions))
		Sessions[sessionID] = new Session(sessionID, userID);
	
	Sessions[sessionID].addUser(userID);
}

// Remove user from previous session and cleanup if empty
function removeUserFromSession(userID) {
	let sessionID = Connections[userID].sessionID;
	if(sessionID in Sessions && Sessions[sessionID].users.has(userID)) {
		let sess = Sessions[sessionID];
		if(sess.drafting) {
			sess.stopCountdown();
			sess.disconnectedUsers[userID] = {
				pickedThisRound: Connections[userID].pickedThisRound,
				pickedCards: Connections[userID].pickedCards
			};
		}
		
		sess.users.delete(userID);
		Connections[userID].sessionID = null;
		if(sess.users.size == 0) {
			let wasPublic = sess.isPublic;
			delete Sessions[sessionID];
			if(wasPublic)
				io.emit('publicSessions', getPublicSessions());
		} else {
			// User was the owner of the session, transfer ownership.
			if(sess.owner == userID) {
				sess.owner = sess.users.values().next().value;
			}
			sess.notifyUserChange();
		}
	}
}

///////////////////////////////////////////////////////////////////////////////
// Express server setup

// Serve files in the public directory
app.use(express.static(__dirname + '/public/'));

///////////////////////////////////////////////////////////////////////////////
// Endpoints
// (TODO: Should be cleaned up)

app.get('/getCollection', (req, res) => {
	if(!req.cookies.sessionID) {
		res.sendStatus(400);
	} else if(req.params.sessionID in Sessions) {
		res.send(Sessions[req.cookies.sessionID].collection());
	} else {
		res.sendStatus(404);
	}
});

app.get('/getCollection/:id', (req, res) => {
	if(!req.params.id) {
		res.sendStatus(400);
	} else if(req.params.sessionID in Sessions) {
		res.send(Sessions[req.params.id].collection());
	} else {
		res.sendStatus(404);
	}
});

app.get('/getUsers/:sessionID', (req, res) => {
	if(!req.params.sessionID) {
		res.sendStatus(400);
	} else if(req.params.sessionID in Sessions) {
		res.send(JSON.stringify([...Sessions[req.params.sessionID].users]));
	} else {
		res.sendStatus(404);
	}
});

// Debug endpoints

const secretKey = "b5d62b91-5f52-4512-b7fc-25626b9be37d";

var express_json_cache = []; // Clear this before calling
app.set('json replacer', function(key, value) {
	// Deal with sets
	if (typeof value === 'object' && value instanceof Set) {
		return [...value];
	}
	// Deal with circular references
	if (typeof value === 'object' && value !== null) {
		if (express_json_cache.indexOf(value) !== -1) {
			// Circular reference found, discard key
			return;
		}
		// Store value in our collection
		express_json_cache.push(value);
	}
	return value;
});

function returnJSON(res, data) {
	express_json_cache = [];
	res.json(data);
	express_json_cache = null; // Enable garbage collection
}

app.get('/getSessions/:key', (req, res) => {
	if(req.params.key ===  secretKey) {
		returnJSON(res, Sessions);
	} else {
		res.sendStatus(401).end();
	}
});

app.get('/getConnections/:key', (req, res) => {
	if(req.params.key ===  secretKey) {
		returnJSON(res, Connections);
	} else {
		res.sendStatus(401).end();
	}
});

http.listen(port, (err) => { 
	if(err) 
		throw err; 
	console.log('listening on port ' + port); 
});
