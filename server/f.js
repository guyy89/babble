


function getMessages(callbackFunction){
    var httpGet = new XMLHttpRequest();
    httpGet.open('GET' , 'www.ynet.co.il');
    httpGet.send();
    httpGet.onload = function(){
        this.responseText;
        callbackFunction(this.responseText);
    }
}

function MyRemder(text){
    console.log(String(text));
}

getMessages(MyRemder);