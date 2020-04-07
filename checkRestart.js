const Heroku = require('heroku-client')

const heroku = new Heroku({ token: process.env.HEROKU_API_TOKEN })
const request = require('request');
const secretKey = process.env.SECRET_KEY || '1234';
const appName = process.env.APP_NAME || "mtgadraftbeta";
const host = `http://${appName}.herokuapp.com/`;

console.log("Checking for a possible restart...");
request(`${host}getStatus/${secretKey}`, function(err, res, body) {
	if(!err) {
		let result = JSON.parse(body);
		console.log(result);
		// If uptime is over 20h and no the app is ready to restart...
		if(result.canRestart && uptime > 60 * 60 * 20) {
			console.log('Restarting dynos...');
			heroku.delete(`/apps/${appName}/dynos`).then(res => {
				console.log(res);
			});
		}
	} else {
		console.error(err);
	}
});