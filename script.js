(function () {
  "use strict";

  var ROOM_NAME = "MAIN";
  var ROOM_TITLE = "RoadTalk";

  var RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  };

  var els = {
    serverUrl: document.getElementById("serverUrl"),
    joinBtn: document.getElementById("joinBtn"),
    routesBtn: document.getElementById("routesBtn"),
    pickHint: document.getElementById("pickHint"),
    room: document.getElementById("room"),
    roomTitle: document.getElementById("roomTitle"),
    channelDot: document.getElementById("channelDot"),
    statusText: document.getElementById("statusText"),
    participants: document.getElementById("participants"),
    emptyHint: document.getElementById("emptyHint"),
    micBtn: document.getElementById("micBtn"),
    micIcon: document.getElementById("micIcon"),
    pttHint: document.getElementById("pttHint"),
    leaveBtn: document.getElementById("leaveBtn")
  };

  var state = {
    ws: null,
    myId: null,
    localStream: null,
    muted: false,
    peers: {},
    audioEls: {},
    rows: {}
  };


  // Save Render server address
  els.serverUrl.value = localStorage.getItem("roadtalk_server") || "";

  els.serverUrl.addEventListener("change", function () {
    localStorage.setItem(
      "roadtalk_server",
      els.serverUrl.value.trim()
    );
  });


  function setStatus(text, kind) {
    els.statusText.textContent = text;
    els.statusText.className = "status" + (kind ? " " + kind : "");
  }


  function serverUrl() {
    return els.serverUrl.value.trim();
  }


  // ---------------- PARTICIPANTS ----------------

  function addParticipant(id, name) {

    if (state.rows[id]) return state.rows[id];

    if (els.emptyHint.parentNode) {
      els.emptyHint.remove();
    }

    var row = document.createElement("div");
    row.className = "participant";

    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = name.substring(0,2).toUpperCase();

    var label = document.createElement("div");
    label.className = "name";
    label.textContent = name;

    row.appendChild(avatar);
    row.appendChild(label);

    els.participants.appendChild(row);

    state.rows[id] = {
      row: row
    };

    return state.rows[id];
  }


  function removeParticipant(id) {

    if (state.rows[id]) {
      state.rows[id].row.remove();
      delete state.rows[id];
    }

  }


  // ---------------- WEBRTC ----------------


  function sendSignal(target, payload) {

    if (!state.ws) return;

    state.ws.send(JSON.stringify({
      type:"signal",
      target:target,
      payload:payload
    }));
  }


  function createPeer(peerId, initiator) {

    var pc = new RTCPeerConnection(RTC_CONFIG);

    state.peers[peerId] = pc;


    state.localStream.getTracks().forEach(function(track){

      pc.addTrack(track,state.localStream);

    });


    pc.onicecandidate = function(e){

      if(e.candidate){

        sendSignal(peerId,{
          candidate:e.candidate
        });

      }

    };


  pc.ontrack = function(e){

console.log("Audio received from:", peerId);

var audio = document.createElement("audio");

audio.autoplay = true;
audio.playsInline = true;
audio.controls = false;
audio.muted = false;

audio.srcObject = e.streams[0];

document.body.appendChild(audio);

state.audioEls[peerId] = audio;

audio.play().catch(function(err){
  console.log("Audio play blocked:", err);
});


addParticipant(
  peerId,
  "Driver " + peerId.substring(0,4)
);

};


    if(initiator){

      pc.createOffer()
      .then(function(offer){

        return pc.setLocalDescription(offer);

      })
      .then(function(){

        sendSignal(peerId,{
          sdp:pc.localDescription
        });

      });

    }


    return pc;

  }



  function handleSignal(from,payload){

    var pc =
      state.peers[from] ||
      createPeer(from,false);


    if(payload.sdp){

      pc.setRemoteDescription(
        new RTCSessionDescription(payload.sdp)
      )
      .then(function(){

        if(payload.sdp.type==="offer"){

          return pc.createAnswer();

        }

      })
      .then(function(answer){

        if(!answer) return;

        return pc.setLocalDescription(answer);

      })
      .then(function(){

        if(pc.localDescription){

          sendSignal(from,{
            sdp:pc.localDescription
          });

        }

      });


    }


    if(payload.candidate){

      pc.addIceCandidate(
        new RTCIceCandidate(payload.candidate)
      );

    }

  }
    // ---------------- JOIN / LEAVE ----------------


  function joinChat(){

    var url = serverUrl();


    if(!url){

      setStatus(
        "Enter the server address above first",
        "error"
      );

      els.serverUrl.focus();
      return;

    }


    if(
      url.indexOf("ws://") !== 0 &&
      url.indexOf("wss://") !== 0
    ){

      setStatus(
        "Server must start with ws:// or wss://",
        "error"
      );

      return;

    }



    navigator.mediaDevices.getUserMedia({

      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true
      }

    })

    .then(function(stream){


      state.localStream = stream;
      console.log("Microphone tracks:",
stream.getAudioTracks());


      stream.getAudioTracks().forEach(function(track){

        track.enabled=true;

      });



      els.joinBtn.style.display="none";

      els.pickHint.style.display="none";

      els.room.classList.remove("hidden");

      els.roomTitle.textContent=ROOM_TITLE;


      addParticipant("me","You");


      setStatus(
        "Connecting...",
        null
      );


      connectServer(url);


    })


    .catch(function(error){

      console.log(error);

      setStatus(
        "Microphone permission denied",
        "error"
      );

    });


  }




  function connectServer(url){


    state.ws = new WebSocket(url);



    state.ws.onopen=function(){


      state.ws.send(JSON.stringify({

        type:"join",

        lang:ROOM_NAME

      }));


    };



    state.ws.onmessage=function(event){


      var msg;


      try{

        msg=JSON.parse(event.data);

      }

      catch(e){

        return;

      }



      if(msg.type==="joined"){


        state.myId=msg.id;


        setStatus(
          "Live",
          "live"
        );


        els.channelDot.classList.add("live");


        els.micBtn.disabled=false;



        msg.peers.forEach(function(peer){

          createPeer(peer,true);

        });


      }



      else if(msg.type==="peer-joined"){


        createPeer(
          msg.id,
          false
        );


      }



      else if(msg.type==="peer-left"){


        removeParticipant(msg.id);


      }



      else if(msg.type==="signal"){


        handleSignal(
          msg.from,
          msg.payload
        );


      }


    };




    state.ws.onerror=function(){


      setStatus(
        "Could not reach signaling server",
        "error"
      );


    };



    state.ws.onclose=function(){


      setStatus(
        "Disconnected",
        "error"
      );


      els.channelDot.classList.remove("live");


    };


  }





  function leaveChat(){


    if(state.ws){

      state.ws.close();

      state.ws=null;

    }



    Object.keys(state.peers).forEach(function(id){

      state.peers[id].close();

      delete state.peers[id];

    });



    if(state.localStream){

      state.localStream
      .getTracks()
      .forEach(function(track){

        track.stop();

      });


      state.localStream=null;

    }



    els.room.classList.add("hidden");


    els.joinBtn.style.display="block";


    els.joinBtn.disabled=false;


    els.pickHint.style.display="block";


    els.channelDot.classList.remove("live");


    setStatus(
      "Ready",
      null
    );


  }





  // ---------------- BUTTONS ----------------


  els.joinBtn.addEventListener(
    "click",
    function(){

      joinChat();

    }
  );



  els.leaveBtn.addEventListener(
    "click",
    function(){

      leaveChat();

    }
  );



  els.micBtn.addEventListener(
    "click",
    function(){


      state.muted=!state.muted;



      state.localStream
      .getAudioTracks()
      .forEach(function(track){

        track.enabled=!state.muted;

      });



      els.micIcon.textContent =
        state.muted ? "🔇" : "🎤";


      els.pttHint.textContent =
        state.muted ?
        "Muted" :
        "Live — everyone can hear you";


    }
  );

  // ---------------- WTD TRACKER ----------------

  els.routesBtn.addEventListener("click", function () {
    window.location.href = "/wtd.html";
  });



})();