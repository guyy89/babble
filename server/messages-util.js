function messages(){
    var MsgId = 0;
    var ArrayMsg = [];
    this.addMessage = function(message){
        console.log('From addMessage function');
        MsgId = MsgId + 1;
        ArrayMsg[String(MsgId)] = message;
        console.log('The new msg is: ' + message);
        console.log('Msg ID is: ' + MsgId);
        return MsgId;
    }
    this.getMessages = function(counter){
        var ArrayToReturn = Array();
        var temp = 0;
        for (var key in ArrayMsg) {
            if(parseInt(key)>counter){
                ArrayToReturn.push(ArrayMsg[key]);
            }
          }
        return ArrayToReturn;
    }
    this.deleteMessage = function(id){
        console.log('DELETE - ID: ' + id + ' MSG: ');
        delete ArrayMsg[String(id)];
    }   
    this.getNumberOfMessages = function(){
        return Object.keys(ArrayMsg).length;
    }
    this.getMessageById = function(id){
        return ArrayMsg[String(id)];
    }
}

module.exports = new messages();

