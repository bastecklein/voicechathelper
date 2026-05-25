# voicechathelper

Library for facilitating cross platform real time voice chat.

**Usage**

```javascript
import { createChannel, joinChannel } from "voicechathelper";

const signalingServer = "https://your-signaling-server.example";

const channel = createChannel(signalingServer, {
    username: "alice"
});

await channel.setMute(false);

channel.onTalk = (info) => {
    console.log(info.user, info.talking);
};

channel.sendDataPacket({
    type: "ping",
    at: Date.now()
});

const joined = joinChannel("room-123", signalingServer, {
    username: "bob"
});

joined.setVolume(0.8);
```