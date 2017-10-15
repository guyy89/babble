"use strict";

function InitLocalStorage(){
    //localStorage.clear();
    var MyStorage =  localStorage.getItem('babble');
    if(MyStorage!=null){
        return;
    }
    var StorageArray = {
        currentMessage: '',
        userInfo: {
            name: '',
            email: ''
        }
    };
    localStorage.setItem('babble' , JSON.stringify(StorageArray));
}

function GetCurrentMessageFromLocalStorage(){
    var MyStorage =  localStorage.getItem('babble');
    return String((JSON.parse(MyStorage))['currentMessage']);
}

function GetUserInfoFromLocalStorage(Element){
    var MyStorage =  localStorage.getItem('babble');
    return String((JSON.parse(MyStorage))['userInfo'][Element]);
}


function SetLocalStorage(ElementName , Data){
    var MyStorage =  localStorage.getItem('babble');
    //Convert to Json Obj
    MyStorage = JSON.parse(MyStorage);
    MyStorage[ElementName] = Data;
    //Convert to String Obj
    MyStorage = JSON.stringify(MyStorage);
    localStorage.setItem('babble' , MyStorage);
}

function CheckEmailAddes(email){
    var re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(email);
}

function HiddenLogInBox(){
    var LogIlBox = document.getElementsByClassName("LogIn")[0];
    if(LogIlBox != undefined){
        LogIlBox.style.zIndex = '-1';
    }
}

function LogIN(){
    var user;
    try{
        user = GetUserInfoFromLocalStorage('email');
        Babble.getMyAllMessagesId();
        HiddenLogInBox();
    }catch(e){
        user = undefined;
    }
    if(user == undefined || user == ''){
        var LogIlBox = document.getElementsByClassName("LogIn")[0];
        LogIlBox.style.zIndex = '3';
    }
}

function LogInSave(){
    var UserName = document.getElementsByClassName("LogIn-textBox")[0].value;
    var UserEmail = document.getElementsByClassName("LogIn-textBox")[1].value;
    if(UserName.length!=0 && CheckEmailAddes(UserEmail)){
        console.log('Save');
        var UserInfo = {
            name: UserName,
            email: UserEmail
        };
        Babble.register(UserInfo);
    }
    else{
        LogInAnonymous();
        return;
    }
}

function LogInAnonymous(){
    var StorageArray = {
        currentMessage: '',
        userInfo: {
            name: '',
            email: ''
        }
    };
    localStorage.setItem('babble' , JSON.stringify(StorageArray));
    //SetLocalStorage('userInfo' , UserInfo);
    HiddenLogInBox();
    Babble.getMyAllMessagesId();
}

/**
 * calc geometry of screen
 * save the last massage of the user
 * find 'Enter' and send massage to the server
 */

function calcNewGeo(){
    //Get elements
    var inputtextarea = document.getElementsByClassName("TextSection")[0];
    var maintarea = document.getElementsByClassName("Main")[0];
    var cs = window.getComputedStyle(inputtextarea,null);
    var FonfSize = parseInt(cs['font-size'].split('px')[0]);
    inputtextarea.value = GetCurrentMessageFromLocalStorage();
    //Default settings
    inputtextarea.style.height = '50px';
    maintarea.style.height = '0px';
    var SizeOfTextArea = 50;
    var SizeOfMainArea = 0;

    CalcMainAreaHeight(maintarea , inputtextarea);
    ScrollOl();
    inputtextarea.addEventListener("input" , calcfun);
    //Calc "Main" area heigth depends on screen size
    function CalcMainAreaHeight(MainArea , InputTextArea){
        var mainrect = MainArea.getBoundingClientRect();
        var textrect = InputTextArea.getBoundingClientRect();
        SizeOfMainArea = parseInt(textrect.top) - parseInt(mainrect.bottom) - 10;
        MainArea.style.height = String(SizeOfMainArea) + 'px';
    }
    //Scroll down all ol (order list)
    function ScrollOl(){
        var AllMsgs = document.getElementsByClassName("AllMsgs")[0];
        AllMsgs.scrollTop = AllMsgs.scrollHeight;
    }
    function calcfun(){
        var text = inputtextarea.value;
        //Update user massage in local storage
        SetLocalStorage('currentMessage' , text);
        var ifTextToSend = text.split('\n');
        for(var i = 0 ; i < (ifTextToSend.length-1) && ifTextToSend.length > 1; i++){
            Babble.postMessage(ifTextToSend[i], upDataMessages);
            delete ifTextToSend[i];
            text = ifTextToSend.join('');
            inputtextarea.value = text;
            SetLocalStorage('currentMessage' , text);
        }
        inputtextarea.style.height = '50px';
        maintarea.style.height = String(SizeOfMainArea) + 'px';
        SizeOfTextArea = 50;
        var numOfPixel = inputtextarea.style.height;
        if(inputtextarea.scrollHeight >= 300){
            inputtextarea.style.height = '300px';
            maintarea.style.height = String(SizeOfMainArea - 250 ) + 'px';
            ScrollOl();
            return;
        }
        while(inputtextarea.scrollHeight>SizeOfTextArea && inputtextarea.scrollHeight<300){
            var numOfPixel = inputtextarea.style.height;
            var val = numOfPixel.split('px');
            val = parseInt(val) + FonfSize;
            inputtextarea.style.height = String(val) + 'px';
            SizeOfTextArea = val;
            var val = parseInt(maintarea.style.height.split('px'));
            val = val - FonfSize;
            maintarea.style.height = String(val) + 'px';
        }
        ScrollOl();
    }
};

function upDataScreenMessages(JsonArray){
    if(JsonArray == null){
        return;
    }
    if("del" in JsonArray){
        if(JsonArray.del != ''){
            upDateAfterDelete(parseInt(JsonArray.del));
            return;
        }else{
            try{
                JsonArray = JSON.parse(JsonArray.new);
            }catch(e){
                return;
            }
        }
    }
    var AllMsgs = document.getElementsByClassName("AllMsgs")[0];
    /*while(AllMsgs.hasChildNodes()) {
        AllMsgs.removeChild(AllMsgs.lastChild);
    }*/
    
    for(var msg in JsonArray){
        var li = document.createElement("li");
        var att = document.createAttribute("class");
        att.value = "MsgID"+JsonArray[msg].id;
        li.setAttributeNode(att);
        var div = document.createElement("div");
        var img = document.createElement("img");
        var article = document.createElement("article");
        var cite = document.createElement("cite");
        var time = document.createElement("time");
        var button = document.createElement("button");
        var p = document.createElement("P");
        var att = document.createAttribute("class");
        att.value = "MessageParagraph";
        p.setAttributeNode(att);
        var date = new Date(parseInt(JsonArray[msg].timestamp));
        time.setAttribute('datetime' , new Date(parseInt(JsonArray[msg].timestamp)).toUTCString());
        var text = document.createTextNode(date.getHours() + ':' + date.getMinutes());
        time.appendChild(text);
        var text = document.createTextNode(JsonArray[msg].name);
        cite.appendChild(text);
        //var text = document.createTextNode(String(JsonArray[msg].message).toString('utf-8'));
        //p.appendChild(text);
        p.innerText = JsonArray[msg].message;
        img.setAttribute('src' , String(JsonArray[msg].img));
        img.setAttribute('alt' , ' ');
        article.appendChild(cite);
        article.appendChild(time);
        if(Babble.ifThisIdIsExist(JsonArray[msg].id)){
            button.setAttribute('aria-label' , 'Delete my message');
            button.setAttribute('onclick' , 'Babble.deleteMessage(' + String(JsonArray[msg].id) + ',upDateAfterDelete)');
            article.appendChild(button);
        }
        article.appendChild(p);
        div.appendChild(img);
        div.appendChild(article);
        li.appendChild(div);
        AllMsgs.appendChild(li);
        Babble.upDateLastIdMessage(JsonArray[msg].id);
    }
    var AllMsgs = document.getElementsByClassName("AllMsgs")[0];
    AllMsgs.scrollTop = AllMsgs.scrollHeight;
};

function upDataMessages(newId){
    Babble.getStats(upDataStats);
    //Babble.getAllMessage(upDataScreenMessages);
}

function upDataStats(stats){
    console.log(stats);
    var NumberOfMessages = document.getElementsByClassName("NumberOfMessages")[0];
    var NumberOfUsers = document.getElementsByClassName("NumberOfUsers")[0];
    var convert = stats;
    NumberOfMessages.innerHTML = String(convert.messages);
    NumberOfUsers.innerHTML = String(convert.users);
    console.log(stats);
}

function upDateAfterDelete(id){
    Babble.getStats(upDataStats);
    var AllMsgs = document.getElementsByClassName("AllMsgs")[0];
    var lis = AllMsgs.getElementsByTagName("li");
    for(var l in lis){
        if(lis[l].className == 'MsgID'+String(id)){
            AllMsgs.removeChild(lis[l]);
            if(AllMsgs.getElementsByTagName("li").length == 0){
                Babble.upDateLastIdMessage(0);
                return;
            }
            var lastId = parseInt(AllMsgs.lastChild.className.split('MsgID')[1]);
            Babble.upDateLastIdMessage(lastId);
            return;
        }
    }
}

/*setLastMassage();*/

function Babblee(){
    var HostName = document.location.hostname;
    var MassegesIdArray = new Array();
    var LastIdMessage = 0;
    this.upDateLastIdMessage = function(id){
        LastIdMessage = id;
    };
    this.getMyAllMessagesId = function(){
        var email = GetUserInfoFromLocalStorage('email');
        if(email == ''){
            return;
        }
        var xmlhttp = new XMLHttpRequest();
        xmlhttp.open('POST', 'http://'+HostName+':9000/getMyAllMessagesId');
        xmlhttp.send(JSON.stringify({email: email}));
        xmlhttp.onload = function () {
            console.log("getMyAllMessagesId: " + this.responseText);
            var json = JSON.parse(this.responseText);
            for(var i in json){
                MassegesIdArray.push(json[i].id);
            }
        };
    }
    this.setNewId = function(id){
        MassegesIdArray.push(id);
    }
    this.ifThisIdIsExist = function(id){
        return MassegesIdArray.includes(id);
    }
    this.register = function(reg){
        if(reg != undefined){
            //SetLocalStorage('userInfo',reg);
            var MyStorage =  localStorage.getItem('babble');
            var json = JSON.parse(MyStorage);
            json['userInfo'] = reg;
            localStorage.setItem('babble' , JSON.stringify(json));
        }
        if(GetUserInfoFromLocalStorage('email') != ''){
            HiddenLogInBox();
        }
    }
    this.deleteMessage = function(id , callBackFunction){
        var client=new XMLHttpRequest();
        client.open("DELETE",'http://'+HostName+":9000/messages/"+id,true);
        client.send();
        client.onload = function(){
            callBackFunction(this.responseText == 'true');
        }
    }
    this.postMessage = function(msgText,callBackFunction){
        var MsgToSend = '';
        var email = ''
        var naem = '';
        var time;
        try{
            if(typeof(msgText) === 'string'){
                throw "string object";
            }
            JSON.stringify(msgText);
            MsgToSend = msgText.message;
            email = msgText.email;
            name = msgText.name;
            time = msgText.timestamp;
        }catch(e){
            var TextSection = document.getElementsByClassName("TextSection")[0];
            if(msgText != null && msgText.length>0){
                MsgToSend = msgText;
            }else{
                var MsgToSend = document.getElementsByClassName("TextSection")[0].value;
                TextSection.value  = '';
            }
            if(MsgToSend.length == 0 || MsgToSend == '\n'){
                return false;
            }
            name = GetUserInfoFromLocalStorage('name');
            email = GetUserInfoFromLocalStorage('email'); 
            MsgToSend = MsgToSend;
            time = Date.now();
        }
        var xmlhttp = new XMLHttpRequest();   // new HttpRequest instance 
        var SendToServer = {
            name:name, 
            email:email, 
            message:MsgToSend, 
            timestamp:time
        };
        xmlhttp.open('POST', 'http://'+HostName+':9000/messages' , true);
        console.log(JSON.stringify(SendToServer));
        xmlhttp.send(JSON.stringify(SendToServer));
        xmlhttp.onload = function () {
            //Babble.upDateLastIdMessage(parseInt(this.responseText));
            Babble.setNewId(parseInt(this.responseText));
            callBackFunction(JSON.parse(this.responseText));
        };
        return false;
    };

    this.getAllMessage = function(callBackFunction){
        var xmlhttp = new XMLHttpRequest();
        xmlhttp.open('GET', 'http://'+HostName+':9000/getAllMessages' , true);
        xmlhttp.send();
        xmlhttp.onload = function () {
            callBackFunction(JSON.parse(this.responseText));
            Babble.getStats(upDataStats);
            Babble.longPolling();
        };
        xmlhttp.ontimeout = function () {
            Babble.longPolling();
        }
    };
    this.getStats = function(callBackFunction){
        var xmlhttp = new XMLHttpRequest();
        xmlhttp.open('GET', 'http://'+HostName+':9000/stats' , true);
        xmlhttp.send();
        xmlhttp.onload = function () {
            callBackFunction(JSON.parse(this.responseText));
        };
    };
    this.getMessageslongPolling = function(number , callBackFunction){
        var xmlhttp = new XMLHttpRequest();
        if(number == undefined){
            Babble.longPolling();
            return;
        }
        xmlhttp.open('GET', 'http://'+HostName+':9000/messageslongpolling?counter='+number , true);
        xmlhttp.send();
        xmlhttp.onload = function () {
            if(number >= LastIdMessage && this.responseText != null){
                callBackFunction(JSON.parse(this.responseText));
                Babble.getStats(upDataStats);
            }
            Babble.longPolling();
        };
        xmlhttp.ontimeout = function () {
            Babble.longPolling();
        }
    };
    this.getMessages = function(number , callBackFunction){
        var xmlhttp = new XMLHttpRequest();
        xmlhttp.open('GET', 'http://'+HostName+':9000/messages?counter='+number , true);
        xmlhttp.send();
        xmlhttp.onload = function () {
            callBackFunction(JSON.parse(this.responseText));
        };
    };
    this.longPolling = function(){
        setTimeout(Babble.getMessageslongPolling , 500 ,LastIdMessage, upDataScreenMessages);
    }
}
window.Babble = new Babblee();
