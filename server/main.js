function main(){
    var users = require('./users-utils');
    var longPolling_counter = new Array();
    var longPolling_res = new Array();
    var HttpLogicService = require('http');
    var url = require('url');
    var express = require('express');
    var cors = require('cors');
    var app = express();
    var bodyParser = require('body-parser');
    app.use(cors()); 
    app.use(bodyParser.text({defaultCharset: 'utf-8'}));
    app.use(bodyParser.json()); // for parsing application/json
    app.use(bodyParser.urlencoded({ extended: true }));
    app.post('/messages', function(req, res, next) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT ,DELETE');
        var DataFromWeb;
        try {
            DataFromWeb = JSON.parse(req.body);
        } catch(e) {
            //bad data request
            console.log('bad data request');
            res.writeHead(400);
            return;
        }
        res.writeHead(200);
        var IDNum = users.addNewMessage(DataFromWeb);
        res.end(String(IDNum));
        while(longPolling_counter.length){
            console.log('-------------');
            c = longPolling_counter.pop();
            r = longPolling_res.pop();
            console.log(c);
            var newMessages = users.getNewMessages(parseInt(c));
            var response = {
                del: '',
                new: JSON.stringify(newMessages)
            };
            r.writeHead(200);
            r.end(JSON.stringify(response));
        }
     });
     /************************ */
     app.get('/stats', function(req, res) {
         var stats = {
             users: users.getUsersNumber(),
             messages: users.getMessagesNumber()
         }
         res.setHeader('Access-Control-Allow-Origin', '*');
         res.setHeader('Content-Type', 'application/json');
         res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT ,DELETE');
         res.writeHead(200);
         res.end(JSON.stringify(stats));
     });
     /************************ */
     app.get('/getAllMessages', function(req, res) {
        var masseges = users.getAllMessages();
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT ,DELETE');
        res.writeHead(200);
        res.end(JSON.stringify(masseges));
     });
     /************************ */
     app.post('/getMyAllMessagesId', function(req, res) {
        console.log('getAllMessages');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT ,DELETE');
        var DataFromWeb;
        try {
            DataFromWeb = JSON.parse(req.body);
        } catch(e) {
            //bad data request
            console.log('bad data request');
            res.writeHead(400);
            return;
        }
        var massegesId = users.getAllMessagesIdByEmail(DataFromWeb);
        res.writeHead(200);
        res.end(JSON.stringify(massegesId));

     });
     /************************ */
     app.param('id', function (req, res, next, id) {
        next();
      });
      app.delete('/messages/:id', function(req, res,next) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
        res.setHeader('Content-Type', 'application/json');
        var IdNumberToDelete = 0;
        try{
            IdNumberToDelete = parseInt(req.params.id);
        }catch(e){
            res.writeHead(400);
            return;
        }
        users.deleteMessageById(IdNumberToDelete);
        res.writeHead(200);
        res.end();
        while(longPolling_counter.length){
            console.log('-------------');
            c = longPolling_counter.pop();
            r = longPolling_res.pop();
            console.log(c);
            var newMessages = users.getNewMessages(parseInt(c));
            var response = {
                del: String(IdNumberToDelete),
                new: ''
            };
            r.writeHead(200);
            r.end(JSON.stringify(response));
        }
     });
     app.get('/messages', function(req, res) {
        if(req.query.counter == undefined){
            res.writeHead(400);
            res.end();
            return;
        }
        var counter;
        counter = filterInt(req.query.counter);
        if(isNaN(counter)){
            res.writeHead(400);
            res.end();
            return;
        }
        counter = parseInt(req.query.counter);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT ,DELETE');
        var counterMessages = users.getCounterMessages(counter);
        res.end(JSON.stringify(counterMessages));
        console.log(JSON.stringify(counterMessages));
     });
    app.get('/messageslongpolling', function(req, res) {
        if(req.query.counter == undefined){
            res.writeHead(400);
            res.end();
            return;
        }
        var counter;
        counter = filterInt(req.query.counter);
        if(isNaN(counter)){
            res.writeHead(400);
            res.end();
            return;
        }
        counter = parseInt(req.query.counter);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT ,DELETE');
        if(users.getMessagesNumber()>counter){
            var newMessages = users.getNewMessages(counter);
            res.writeHead(200);
            var response = {
                del:'',
                new:JSON.stringify(newMessages)
            };
            res.end(JSON.stringify(response));
            console.log(JSON.stringify(newMessages));
        }else{

            longPolling_counter.push(counter);
            longPolling_res.push(res);
        }
     });
    app.listen(9000);
    console.log('Server: Start!');
    var filterInt = function(value) {
        if (/^(\-|\+)?([0-9]+|Infinity)$/.test(value))
          return Number(value);
        return NaN;
      }
}

main();