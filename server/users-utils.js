function users(){
    var messages = require('./messages-util');
    var md5 = require('md5');
    var ArrayUsers = new Array();
    this.checkIfUserExist = function(email){
        if(ArrayUsers[email] == null){
            return false;
        }
        return true;
    }
    //Json Object
    this.addNewUser = function(user){
        var name = '';
        var img = '';
        var email;
        if(user.email == ''){
            img = 'images/AnonymousImage.png';
            name = 'Anonymous';
            email  = 'Anonymous';
        }else{
            img = 'https://www.gravatar.com/avatar/' + md5(user.email) + '.jpg';
            name = user.name;
            email = user.email;
        }
        var NewUser = {
            name: name,
            img: img,
            msgs: [],
            lastmsg: 0
        }
        ArrayUsers[email] = NewUser;
    }
    this.upDateMsgUser = function(email, id , time){
        if(email == ''){
            email = 'Anonymous';
        }
        ArrayUsers[email].msgs[id] = time;
    }
    this.addNewMessage = function(msg){
        if(!this.checkIfUserExist(msg.email)){
            this.addNewUser(msg);
        }
        var MsgId = messages.addMessage(msg.message);
        this.upDateMsgUser(msg.email, MsgId, msg.timestamp);
        return MsgId;
    }
    this.getUsersNumber = function(){
        return Object.keys(ArrayUsers).length;
    };
    this.getMessagesNumber = function(){
        return messages.getNumberOfMessages();
    };
    this.getAllMessages = function(){
        var MessagesArray = new Array();
        for(var user in ArrayUsers){
            for(var msgId in ArrayUsers[user].msgs){
                var msg = {
                  name: ArrayUsers[user].name,
                  img: ArrayUsers[user].img,
                  timestamp:  ArrayUsers[user].msgs[msgId],
                  message: messages.getMessageById(msgId),
                  id: parseInt(msgId)
                };
                MessagesArray.push(msg);
            }
        }
        MessagesArray = this.sortById(MessagesArray);
        return MessagesArray;
    };
    this.getAllMessagesIdByEmail = function(email){
        var ReturnArray = new Array();
        if(ArrayUsers[email.email] == null){
            return ReturnArray;
        }
        for(var id in ArrayUsers[email.email].msgs){
            ReturnArray.push({id:parseInt(id)});
        }
        return ReturnArray;
    };
    this.deleteMessageById = function(id){
        for(var user in ArrayUsers){
            if(ArrayUsers[user].msgs[id] != null){
                ArrayUsers[user].msgs.splice(id, 1);
                messages.deleteMessage(id);
                return;
            }
        }
    };
    this.getNewMessages = function(counter){
        var arrayToReturn = new Array();
        var allMessages = this.getAllMessages();
        console.log(allMessages.length);
        console.log(counter);
        for(var i in allMessages){
           if(allMessages[i].id > counter){
                arrayToReturn.push(allMessages[i]);
           }
        }
        return this.sortById(arrayToReturn);
    };
    this.getCounterMessages = function(counter){
        var arrayToReturn = new Array();
        var allMessages = this.getAllMessages();
        for(var i = counter ; i< allMessages.length ; i++){
            arrayToReturn.push(allMessages[i]);
        }
        return this.sortById(arrayToReturn); 
    };
    this.sortById = function(arrayMsgs){
        return arrayMsgs.sort(this.compare);
    }
    this.compare = function(a, b) {
        if(a.id > b.id){
            return 1;
        }
        if(a.id < b.id){
            return -1;
        }
       return 0;
    };
}

module.exports = new users();
