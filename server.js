var fs = require('fs'),
	http = require('http'),
	server = http.createServer(function(req, resp){
		advance_game();
		expire_sessions();
		if(routes.length){
			routes.forEach(function(r){ r(req,resp) });
		}
	}),
	io = require('socket.io').listen(server);
	
	io.enable('browser client minification');  // send minified client
	io.enable('browser client etag');          // apply etag caching logic based on version number
	io.set('log level', 1);                    // reduce logging
	io.set('transports', [                     // enable all transports (optional if you want flashsocket)
	    'websocket'
	  , 'flashsocket'
	  , 'htmlfile'
	  , 'xhr-polling'
	  , 'jsonp-polling'
	]);

var GAME_STEP = 0,
	snakes = [],
	food = [],
	new_food = [],
	dead_food = [],
	FID = 0,
	sessions = [],
	sockets = [],
	board_size = 150,
	snake_colours = ['olive', 'red', 'blue', 'green', 'orange', 'purple', 'yellow', 'black', 'pink'],
	routes = [],
	limit = 0, 
	time_step = 1000/30, 
	last_step = new Date();
	
function Snake(id, color, x, y, direction){
	var directions = ['Up', 'Right', 'Down', 'Left'];
	this.id = id;
	this.x = x||0;
	this.y = y||0;
	this.color = color;
	this.direction = direction || 0;
	this.next_direction = direction || 0;
	this.tail = [];
	this.length = 3;
	
	this.body = function(){
		var body = this.tail.slice(0,this.length);
		body.unshift(this.position());
		return body;
	}
	this.position = function(){
		return [this.x,this.y].join(',');
	}
	this.death = 0;
	this.die = function(){
		this.death++;
		return this;
	}
	this.move = function(){
		if(this.death > 0) return this;
		this.tail.unshift(this.position());
		this.tail = this.tail.slice(0,this.length);
		this.direction = this.next_direction;
		switch(this.direction){
			// Up
			case 0: this.y--;break;
			// Right
			case 1: this.x++;break;
			// Down
			case 2: this.y++;break;
			// Left
			case 3: this.x--;break;
		}
		return this;
	}
	this.collision = function(){
		var snake = this,
			collision = false,
			pos = snake.position(),
			x = Number(pos.split(',')[0]),
			y = Number(pos.split(',')[1]);

		snakes.forEach(function(s){
			if(s.death>1 || s.id == snake.id) return;
			if(s.position() == pos) collision = true;
			if(s.tail.slice(0,s.length).indexOf(pos)>-1) collision = true;
		});
		if(x < 0 || x >= board_size || y < 0 || y >= board_size){
			if(x < 0) snake.x = board_size-x;
			else if(x > board_size) snake.x = (x-board_size);
			
			if(y < 0) snake.y = board_size-y;
			else if(y > board_size) snake.y = y-board_size;
			collision = true;
		}
		if(this.tail.slice(0,this.length).indexOf(pos)>0) collision = true;
		if(collision){
			this.length-=2;
			var head = this.tail.shift().split(',');
			this.x = Number(head[0]);
			this.y = Number(head[1]);
			this.tail.pop();
		}
		return collision;
	}
	this.turn = function(dir){
		var rev = 0;
		switch(this.direction){
			case 0:
				if(dir == 2) rev++; break;
			case 1:
				if(dir == 3) rev++; break;
			case 2:
				if(dir == 0) rev++; break;
			case 3:
				if(dir == 1) rev++; break;
			default:
				return; break;
		}
		this.next_direction = dir;
		if(rev) this.reverse();
	}
	this.reverse = function(){
		var tail = this.body();
		tail = tail.reverse();
		var head = tail.shift().split(",");
		this.tail = tail;
		var x = Number(head[0]),
			y = Number(head[1]),
			neck = this.tail[0].split(","),
		 	nx = Number(neck[0]),
			ny = Number(neck[1]),
			dir=0;
			
			if(y==ny) void(0);
			else if(y>ny) dir = 2;
			else dir = 0;
		
			if(x==nx) void(0);
			else if(x>nx) dir = 1;
			else dir = 3;
		
		this.x = x;
		this.y = y;
		this.next_direction = dir;
	}
	this.export = function(){
		return [this.death, this.id, this.color].concat(this.body());
	}
	this.toString = function(){
		return this.export().join('|');
	}
}

function UniqueID(len){
	len = len || 16;
	var C = "1234567890ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz!$^*_-+~",
		V = C.length,
		id = "";
	for(var i=0;i<len;i++) id += C[Math.floor(Math.random()*V)];
	return id;
}

function Session(max_age){
	this.id = UniqueID();
	this.snake = null;
	this.name = null;
	
	this.birth = new Date();
	this.latest = this.birth;
	
	this.__defineGetter__('hasExpired', function(){
		return (this.latest.getTime()+(this.max_age*6000) <= new Date().getTime());
	});
	
	this.live = function(){
		this.latest = new Date();
		return this;
	}
	
	this.max_age = max_age || 10000;
	
}

function random_position(){
	return Math.floor(Math.random()*board_size);
}

function create_food_chance(){
	return Math.random() > 0.9749749749749;
}

function Food(id, x,y,expiry){
	this.id = id;
	this.x = x;
	this.y = y;
	this.expiry = expiry;
	this.age = 0;
	this.death = 0;
	this.__defineGetter__('expires_in', function(){
		return this.expiry - this.age;
	});
	this.__defineGetter__('percentage', function(){
		var e = this.expiry,
			a = this.age,
			d = this.death;
		return (e/a) + (d/10);
	});
	this.position = function(){
		return [this.x,this.y].join(',');
	}
	this.export = function(){
		return [this.id, this.x, this.y, this.age, this.death, this.expires_in];
	}
}

function advance_game(){
	if(last_step.getTime() + time_step <= new Date().getTime()){
		last_step = new Date();
		if(create_food_chance()){
			var hbs = board_size/2,
				F = new Food(++FID, random_position(),random_position(), hbs+Math.round(Math.random()*board_size));
			food.push(F);
			new_food.push(F);
		}
		food = food.filter(function(F){
			F.age++;
			if(F.age == F.expiry) F.death++;
			if(F.death > 3){
				dead_food.push(F);
				return false;
			}
			else return true;
		});
		if(!snakes.length) return;
		GAME_STEP++;
		snakes.forEach(function(s){
			if(s.death){
				s.die()
			}else{
				s.move();
				if(s.collision()){
					if(s.length <= 1) s.die();
				}
				var pos = s.position();
				food = food.filter(function(F){
					if(F.position() == pos){
						function D(){ return Math.random()>0.5; }
						s.length+=Math.ceil(Math.random()*(D()?2:D()&&D()?4:D()&&D()&&D()?8:D()&&D()&&D()&&D()?16:D()?32:D()?64:128));
						dead_food.push(F);
						return false;
					}
					return true;
				});
			}
		});
		remove_dead();
		broadcast_updates();
	}
}

function remove_dead(){
	snakes = snakes.filter(function(snake){
		if(snake.death>3){
			snake.sesh.socket.emit('dead','LOL');
			return false;
		}
		return true;
	});
}

function broadcast_updates(){
	if(!sockets.length) return;
	var GAME = {};
	GAME.step = GAME_STEP;
	GAME.snakes = snakes.map(function(snake){ return snake.export().join("|"); }).join(";");
	GAME.new_food = new_food.map(function(f){ return [f.id, f.x, f.y, f.expiry].join("|") }).join(";");
	GAME.dead_food = dead_food.map(function(f){ return f.id; }).join(";");
	new_food = [];
	dead_food = [];
	sockets.forEach(function(socket){
		socket.volatile.emit('update', GAME);
	});
}

function find_session(id){
	return sessions.filter(function(sesh){ return sesh.id == id; })[0];
}

function expire_sessions(){
	if(!sessions.length) return;
	sessions = sessions.filter(function(sesh){
		if(sesh.kill) return false;
		if(!sesh.hasExpired) return true;
		console.log('Session '+sesh.id+' has expired.');
		return false;
	});
	if(!sessions.length) GAME_STEP = 0;
}

function QS(str){
	var qs = {};
	str = str.split('?');
	if(str.length == 1) return false;
	str.shift();
	str = str.join('?');
	str = str.split('&');
	str.forEach(function(s){
		s = s.split('=');
		qs[s[0]]=s[1];
	});
	return qs;
}

routes.push(function(req){
	var url = req.url;
	['/','?','&'].forEach(function(c){ url = url.split(c).join(' '+c+' '); });
	console.log(url);
})

routes.push(function(i,o){
	if(i.url != '/') return;

	fs.readFile('game.html', 'utf8', function(err, html){
		o.writeHead(200, {'Content-Type': 'text/html'});
		if(err) o.end("Error loading page:\n"+err);
		else{
			var sesh = new Session(4);
			sessions.push(sesh);
			html = html.replace('{{SESSION_ID}}', sesh.id);
			html = html.replace('{{GAME_STEP}}', GAME_STEP);
			html = html.replace('{{board_size}}', board_size);
			html = html.replace('{{colours}}', '"'+snake_colours.join('","')+'"');
			o.end(html);
		}
	});
});

io.sockets.on('connection', function(socket){
	
	socket.on('join', function(data){
		var sid = data.sid,
			sesh = find_session(sid),
			colour = snake_colours[data.colour] || 'white',
			username = data.username;
			
		if(!sesh) socket.emit('error', 'Bad Session ID');
		else{
			sesh.live();
			
			var x = Math.round(Math.random()*board_size),
			 	y = Math.round(Math.random()*board_size);

			var dist = {
				top: y, bottom: board_size-y,
				left: x, right: board_size-x
			},
				closest = [dist.top, dist.bottom, dist.left, dist.right].sort()[0],
				dir = 0, dc=0;

			for(var i in dist){
				if(dist[i] == closest) dc = i; 
			}
			switch(dc){
				case 'top': dir = 2; break;
				case 'bottom': dir = 0; break;
				case 'left': dir = 1; break;
				case 'right': dir = 3; break;
				default: dir = 0; break;
			}

			var snake = new Snake(username, colour, x, y, dir);
			snakes.push(snake);
			sesh.snake = snake;
			sesh.socket = socket;
			socket.sesh = sesh;
			snake.sesh = sesh;
			socket.emit('start', {'username': username, 'colour': colour});
		}
		sockets.push(socket);
	});
	
	socket.on('turn', function(direction){
		var dir = Math.abs(direction);
		if(typeof dir != "number" || dir < 0 || dir > 3) socket.emit('error', 'Invalid direction');
		else if(socket.sesh){
			socket.sesh.live();
			socket.sesh.snake.turn(direction);
		}
	});
	
	socket.on('keep_alive', function(sid){
		var sesh = find_session(sid);
		if(sesh) sesh.live();
	});
	
	socket.on('disconnect', function(){
		if(socket.sesh) socket.sesh.kill = true;
		if(socket.sesh && socket.sesh.snake) socket.sesh.snake.death++;
	});
});

setInterval(function(){
	expire_sessions();
	advance_game();
}, 1000/60);

server.listen(8888);

console.log('Server running @ http://localhost:8888');