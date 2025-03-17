import { io } from "socket.io-client";
import { guid } from "common-helpers";

window.addEventListener("load", onLoad);

const TALKING_THRESHOLD = 0.015;

const USE_ICE_SERVERS = [
    {urls: "stun:stun.l.google.com:19302"},
    {urls: "stun:stun.stunprotocol.org:3478"},
    {urls: "stun:stun1.l.google.com:19302"},
    {urls: "stun:stun2.l.google.com:19302"},
    {urls: "stun:stun3.l.google.com:19302"},
    {urls: "stun:stun4.l.google.com:19302"}
];

let channels = {};

let didLoad = false;

let clientUid = null;

let sharedMicStream = null;
let micMuted = true;
let audioContext = null;
let analyser = null;
let audioSource = null;
let dataArray = null;
let hasTalked = false;

let isTalking = false;

export function createChannel() {
    if(!didLoad) {
        onLoad();
    }

    const channel = new VoiceChannel(null);

    channels[channel.id] = channel;

    updateChannelLobbyListing(channel);

    return channel;
}

export function joinChannel(channel) {
    if(!didLoad) {
        onLoad();
    }

    const ch = new VoiceChannel({
        channel: channel
    });

    channels[ch.id] = ch;

    updateChannelLobbyListing(ch);

    return ch;
}

class VoiceChannel {
    constructor(options) {
        this.id = options.id || guid();
        this.signalChannel = options.channel || "aa-vch-" + this.id;
        this.username = options.username || clientUid;
        this.signalingServer = options.signalingServer || null;

        this.voicePingInterval = null;
        this.signalSocket = null;

        this.allPeers = {};
        this.lobbyListing = [];

        this.onTalk = null;
        this.onClientsChange = null;
        this.onDataPacket = null;

        this.volume = 1.0;

        setUpVoiceChannel(this);
    }

    async setMute(muted) {
        if(!muted) {
            if(sharedMicStream) {
                let totalTracks = 0;

                sharedMicStream.getTracks().forEach(function(){
                    totalTracks++;
                });

                if(totalTracks == 0) {
                    sharedMicStream = null;
                    await gooseUpMicStream();
                }
            } else {
                await gooseUpMicStream();
            }
            
        }

        micMuted = muted;

        if(sharedMicStream) {

            sharedMicStream.getTracks().forEach(function(track){
                track.enabled = !micMuted;
            });
    
            if(!micMuted) {
                for(let channelid in channels) {
                    const channel = channels[channelid];
                    announceActive(channel);
                }
            }
        }
    }

    getMuted() {
        return micMuted;
    }

    shutdownChannel() {
        if(this.signalSocket) {

            this.signalSocket.emit("gamemessage",{
                destination: this.signalChannel,
                msg: {
                    m: "disconnectng",
                    u: this.username,
                    c: clientUid
                }
            });

            this.signalSocket.emit("closeconnection");
        }

        this.signalSocket = null;

        for(let peer in this.allPeers) {
            const pc = this.allPeers[peer];
            closeOutPeer(pc, null);
        }

        delete channels[this.id];
    }

    sendDataPacket(packet) {
        if(!this.signalSocket || !this.signalChannel) {
            return;
        }

        this.signalSocket.emit("gamemessage",{
            destination: this.signalChannel,
            msg: {
                m: "dataPacket",
                c: clientUid,
                u: this.username,
                d: packet
            }
        });
    }

    setVolume() {}
}

class VoiceChatPeer {
    constructor() {
        this.id = null;

        this.username = null;
        this.channelId = null;

        this.outgoingStreamConnection = null;
        this.incomingStreamConnection = null;

        this.remoteAudio = null;

        this.negotiationStarted = false;
    }
}

function onLoad() {
    didLoad = true;

    clientUid = localStorage["vch-client-uid"];

    if(!clientUid || clientUid == "0" || clientUid.trim().length == 0) {
        clientUid = guid();
        localStorage["vch-client-uid"] = clientUid;
    }
}

function setUpVoiceChannel(channel) {

    if(!channel || !channel.signalingServer) {
        console.error("VoiceChannel requires a signaling server to be set.");
        return;
    }

    channel.signalSocket = io(channel.signalingServer, {
        secure: true,
        rejectUnauthorized: false
    });

    channel.signalSocket.on("connect",function() {
        onSignalServerConnect(channel);
    });

    channel.signalSocket.on("disconnect",function() {
        onSignalServerDisconnect(channel);
    });

    channel.signalSocket.on("message",function(message){
        onSignalServerMessage(channel, message);
    });
}

async function gooseUpMicStream() {
    if(!sharedMicStream) {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        });

        if(stream) {
            sharedMicStream = stream;

            if(window.AudioContext) {
                if(!audioContext) {
                    audioContext = new AudioContext();
                    analyser = audioContext.createAnalyser();

                    audioSource = audioContext.createMediaStreamSource(sharedMicStream);

                    audioSource.connect(analyser);

                    setInterval(monitorInput, 100);
                }
            }
        }
    }
}

function announceActive(channel) {
    if(!sharedMicStream || !channel.signalSocket || !channel.signalChannel) {
        return;
    }

    hasTalked = true;

    channel.signalSocket.emit("gamemessage",{
        destination: channel.signalChannel,
        msg: {
            m: "imActive",
            c: clientUid,
            u: channel.username
        }
    });

    updateChannelLobbyListing(channel);
}

function closeOutPeer(peer, channel = null) {

    if(!peer) {
        return;
    }

    if(peer.outgoingStreamConnection) {
        try {
            peer.outgoingStreamConnection.close();
        } catch(ex) {
            console.log(ex);
        }
    }

    if(peer.incomingStreamConnection) {
        try {
            peer.incomingStreamConnection.close();
        } catch(ex) {
            console.log(ex);
        }
    }

    if(peer.remoteAudio) {

        try {
            peer.remoteAudio.pause();
        } catch(ex) {
            console.log(ex);
        }

        peer.remoteAudio.srcObject = null;
    }

    peer.outgoingStreamConnection = null;
    peer.incomingStreamConnection = null;
    peer.remoteAudio = null;
    peer.negotiationStarted = false;

    if(channel) {
        delete channel.allPeers[peer.id];
        handleChannelClientsChange(channel);
    }
}

function onSignalServerConnect(channel) {

    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    channel.signalSocket.emit("joinroom", channel.signalChannel);

    setTimeout(function(){
        announceActive(channel);
    },500);

    setTimeout(function(){
        pingChannel(channel);
    },1000);

    channel.voicePingInterval = setInterval(function(){
        pingChannel(channel);
        updateChannelLobbyListing(channel);
    },10000);

    updateChannelLobbyListing(channel);
}

// eslint-disable-next-line no-unused-vars
function onSignalServerDisconnect(channel) {}

function onSignalServerMessage(channel,message) {
    if(!channel || !channel.signalSocket || !channel.signalChannel) {
        return;
    }

    if(!message || !message.m) {
        return;
    }

    if(message.m == "dataPacket") {
        handleDataPacket(channel, message.d, message.u, message.c);
    }

    if(message.m == "isTalking") {
        handleTalkNotice(channel, message.s, message.u, message.c);
    }

    if(message.m == "doPing") {
        announceActive(channel);
    }

    if(message.m == "imActive") {
        checkConnection(channel, message.c, message.u);
    }

    if(message.m == "streamReq") {
        initClient(channel, message.c, message.u, message.p);
    }

    if(message.m == "rtcOffer") {
        handleRTCOffer(channel,message.fc,message.fp,message.o);
    }

    if(message.m == "iceCand") {
        handlPeerIce(channel, message.fc, message.fp, message.i);
    }

    if(message.m == "rtcAns") {
        handleRTCAnswer(channel, message.c, message.fc, message.a);
    }

    if(message.m == "cliIce") {
        handleClientIce(channel, message.c, message.fc, message.i);
    }

    if(message.m == "disconnectng") {
        const cl = channel.allPeers[message.c];
        closeOutPeer(cl, channel);
    }

}

function monitorInput() {

    if (analyser && !analyser.getFloatTimeDomainData) {
        const r = new Uint8Array(2048);

        analyser.getFloatTimeDomainData = function(e) {
            analyser.getByteTimeDomainData(r);

            for (let t = 0, o = e.length; o > t; t++) e[t] = .0078125 * (r[t] - 128);
        };
    }
    
    if(!dataArray) {
        dataArray = new Float32Array(analyser.fftSize);
    }

    analyser.getFloatTimeDomainData(dataArray);

    let sumSquares = 0.0;

    for (const amplitude of dataArray) { sumSquares += amplitude*amplitude; }

    const avg = Math.sqrt(sumSquares / dataArray.length);

    if(avg >= TALKING_THRESHOLD) {
        if(!isTalking) {
            isTalking = true;
            alertChannelsTalking(isTalking);
        }
    } else {
        if(isTalking) {
            isTalking = false;
            alertChannelsTalking(isTalking);
        }
    }

}

function updateChannelLobbyListing(channel) {
    const allUsers = [];
    const gotUsers = [];

    allUsers.push({
        username: channel.username,
        client: clientUid
    });

    for(let prop in channel.allPeers) {
        const peer = channel.allPeers[prop];

        if(gotUsers.indexOf(peer.id) > -1) {
            continue;
        }

        gotUsers.push(peer.id);

        allUsers.push({
            client: peer.id,
            username: peer.username
        });
    }

    channel.lobbyListing = allUsers;
}

function handleChannelClientsChange(channel) {
    updateChannelLobbyListing(channel);

    if(channel.onClientsChange) {
        channel.onClientsChange();
    }
}

function pingChannel(channel) {
    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    channel.signalSocket.emit("gamemessage",{
        destination: channel.signalChannel,
        msg: {
            m: "doPing"
        }
    });

    announceActive(channel);
}

function handleDataPacket(channel, packet, username, client) {
    if(!channel.signalSocket || !channel.signalChannel || client == clientUid) {
        return;
    }

    if(channel.onDataPacket) {
        channel.onDataPacket({
            user: username, 
            clientid: client,
            data: packet
        });
    }
}

function handleTalkNotice(channel, status, username, client) {
    if(!channel.signalSocket || !channel.signalChannel || client == clientUid) {
        return;
    }

    checkConnection(channel, client, username);

    getVoicePeer(channel, client, null);

    if(channel.onTalk) {
        channel.onTalk({
            user: username,
            talking: status,
            clientid: client
        });
    } else {
        if(channel.ontalk) {
            channel.ontalk({
                user: username,
                talking: status,
                clientid: client
            });
        }
    }
    
}

function checkConnection(channel, remoteClient, username) {
    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    const peer = getVoicePeer(channel, remoteClient, username);

    if(!peer.incomingStreamConnection && !peer.negotiationStarted) {
        beginStreamNegotiation(peer, channel);
    }
}

function initClient(channel, remoteClient, username, myPeerId) {
    if(!hasTalked || !channel.signalSocket || !channel.signalChannel) {
        return;
    }

    if(myPeerId != clientUid) {
        return;
    }

    const client = getVoicePeer(channel, remoteClient, username);

    if(!client) {
        return;
    }

    if(client.outgoingStreamConnection) {
        return;
    }

    client.outgoingStreamConnection = new RTCPeerConnection({
        iceServers: USE_ICE_SERVERS
    });

    client.outgoingStreamConnection.onnegotiationneeded = async function() {

        const offer = await client.outgoingStreamConnection.createOffer();
        client.outgoingStreamConnection.setLocalDescription(offer);

        channel.signalSocket.emit("gamemessage",{
            destination: channel.signalChannel,
            msg: {
                m: "rtcOffer",
                fc: remoteClient,
                fp: clientUid,
                o: offer
            }
        });
    };

    client.outgoingStreamConnection.onicecandidate = function(e) {

        if(e && e.candidate) {
            channel.signalSocket.emit("gamemessage",{
                destination: channel.signalChannel,
                msg: {
                    m: "iceCand",
                    fc: remoteClient,
                    fp: clientUid,
                    i: e.candidate
                }
            });
        }
    };

    client.outgoingStreamConnection.onconnectionstatechange = function() {

        const state = client.outgoingStreamConnection.connectionState;

        if(state == "disconnected" || state == "closed" || state == "failed") {
            closeOutPeer(client, channel = null);
        }
        
    };

    addStreamTracksToPeer(client, channel);
}

async function handleRTCOffer(channel, forClient, forPeer, offer) {
    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    if(!forClient || forClient != clientUid) {
        return;
    }

    const peer = getVoicePeer(channel, forPeer, null);

    if(!peer) {
        return;
    }

    if(peer.incomingStreamConnection) {
        return;
    }

    peer.incomingStreamConnection = new RTCPeerConnection({
        iceServers: USE_ICE_SERVERS
    });

    peer.incomingStreamConnection.onconnectionstatechange = function() {

        const state = peer.incomingStreamConnection.connectionState;

        if(state == "disconnected" || state == "closed" || state == "failed") {
            closeOutPeer(peer, channel = null);
        }
    };
    
    peer.incomingStreamConnection.onicecandidate = function(e) {

        if(e && e.candidate) {
            channel.signalSocket.emit("gamemessage",{
                destination: channel.signalChannel,
                msg: {
                    m: "cliIce",
                    c: clientUid,
                    fc: peer.id,
                    i: e.candidate
                }
            });
        }
    };


    peer.incomingStreamConnection.ontrack = function(e) {

        if(e && e.streams && e.streams.length > 0) {

            if(!peer.remoteAudio) {

                peer.remoteAudio = new Audio();
                peer.remoteAudio.onloadedmetadata = async function(){
                    try {
                        await peer.remoteAudio.play();
                    } catch(ex) {
                        console.log(ex);
                        peer.remoteAudio.play();
                    }
                    
                    setTimeout(function() {
                        if(peer.remoteAudio && peer.remoteAudio.paused) {
                            peer.remoteAudio.play();
                        }
                    },1500);
                };
                peer.remoteAudio.autoplay = true;
                peer.volume = channel.volume;
            }

            peer.remoteAudio.srcObject = e.streams[0];

            handleChannelClientsChange(channel);
        }
        
    };

    await peer.incomingStreamConnection.setRemoteDescription(offer);
    const answer = await peer.incomingStreamConnection.createAnswer();
    await peer.incomingStreamConnection.setLocalDescription(answer);

    channel.signalSocket.emit("gamemessage",{
        destination: channel.signalChannel,
        msg: {
            m: "rtcAns",
            c: clientUid,
            fc: peer.id,
            a: answer
        }
    });
}

async function handlPeerIce(channel, forClient, forPeer, ice) {
    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    if(!forClient || forClient != clientUid) {
        return;
    }

    const peer = getVoicePeer(channel, forPeer, null);

    if(!peer) {
        return;
    }

    peer.incomingStreamConnection.addIceCandidate(ice).catch(function(){
        console.log("PEER ICE FAILURE");
    });
}

function handleRTCAnswer(channel, remoteClient, myClient, answer) {
    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    if(!myClient || myClient != clientUid) {
        return;
    }

    const peer = getVoicePeer(channel, remoteClient, null);

    if(!peer) {
        return;
    }

    peer.outgoingStreamConnection.setRemoteDescription(answer);
}

function handleClientIce(channel, remoteClient, myClient, ice) {
    if(!channel.signalSocket || !channel.signalChannel) {
        return;
    }

    if(!myClient || myClient != clientUid) {
        return;
    }

    if(!remoteClient) {
        return;
    }

    const peer = getVoicePeer(channel, remoteClient, null);

    if(!peer) {
        return;
    }

    peer.outgoingStreamConnection.addIceCandidate(ice).catch(function(){
        console.log("ice fail?");
    });
}

function alertChannelsTalking(talking) {
    for(let channelid in channels) {
        let channel = channels[channelid];
        
        if(channel.signalChannel && channel.signalSocket) {

            channel.signalSocket.emit("gamemessage",{
                destination: channel.signalChannel,
                msg: {
                    m: "isTalking",
                    s: talking,
                    u: channel.username,
                    c: clientUid
                }
            });
    
        }
    }
}

function getVoicePeer(channel, id, username) {
    if(!channel) {
        return null;
    }

    let client = channel.allPeers[id];

    if(!client) {

        if(!username) {
            username = id;
        }

        client = new VoiceChatPeer();

        client.id = id;
        client.username = username;
        client.channelId = channel.id;

        channel.allPeers[id] = client;
    }

    return client;
}

function beginStreamNegotiation(peer, channel) {

    peer.negotiationStarted = true;

    channel.signalSocket.emit("gamemessage",{
        destination: channel.signalChannel,
        msg: {
            m: "streamReq",
            c: clientUid,
            u: channel.username,
            p: peer.id
        }
    });

    setTimeout(function() {

        if(!peer.incomingStreamConnection) {
            peer.negotiationStarted = false;
            peer.incomingStreamConnection = null;
        }
    }, 2000);
}

function addStreamTracksToPeer(peer, channel) {
    if(!peer) {
        return;
    }

    let totalTracks = 0;

    sharedMicStream.getTracks().forEach(function(track){
        totalTracks++;
        peer.outgoingStreamConnection.addTrack(track, sharedMicStream);
        handleChannelClientsChange(channel);
    });

    setTimeout(async function() {
        if(totalTracks == 0) {
            sharedMicStream = null;
            await gooseUpMicStream();

            setTimeout(function() {
                addStreamTracksToPeer(peer, channel);
            }, 2500);
        }
    });
}