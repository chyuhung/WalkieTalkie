/* WebRTC P2P 实时对讲（mesh 拓扑）
 * 依赖：window.PTT.send 需由 app.js 注入 WebSocket 发送函数
 */
window.PTT = (function () {
  'use strict';

  var peers = {};        // userId -> { pc, senderTrack, audioEl }
  var localStream = null;
  var micGranted = false;
  var iceConfig = { iceServers: [] };
  var onStateChange = null;  // 回调，通知 UI 某成员说话状态

  function send(obj) {
    if (window.PTT.send && window.PTT.send(obj)) { /* ok */ }
  }

  function setIce(servers) {
    if (Array.isArray(servers)) { iceConfig.iceServers = servers; }
  }

  function setStateCallback(fn) { onStateChange = fn; }

  // 获取麦克风流（复用，避免每次按住说话都弹权限框）
  function ensureMic() {
    if (micGranted) { return Promise.resolve(localStream); }
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      localStream = stream;
      micGranted = true;
      // 创建 PC 后获取到的流，需补挂到已有 peer
      Object.keys(peers).forEach(attachTracks);
      return stream;
    }).catch(function (err) {
      console.error('麦克风获取失败', err);
      throw err;
    });
  }

  function createPeer(remoteId) {
    if (peers[remoteId]) { return peers[remoteId].pc; }
    var pc = new RTCPeerConnection(iceConfig);
    var entry = { pc: pc, senderTracks: [], audioEl: null, attached: false };
    peers[remoteId] = entry;

    pc.onicecandidate = function (ev) {
      if (ev.candidate) {
        send({ type: 'webrtc_ice', to: remoteId, data: { candidate: ev.candidate } });
      }
    };
    pc.ontrack = function (ev) {
      if (ev.streams && ev.streams[0]) {
        ensureAudioEl(remoteId, ev.streams[0]);
      }
    };
    if (localStream) { attachTracks(remoteId); }
    return pc;
  }

  function attachTracks(remoteId) {
    var entry = peers[remoteId];
    if (!entry || !localStream || entry.attached) { return; }
    localStream.getAudioTracks().forEach(function (track) {
      entry.senderTracks.push(entry.pc.addTrack(track, localStream));
    });
    entry.attached = true;
  }

  function ensureAudioEl(remoteId, stream) {
    var entry = peers[remoteId];
    if (!entry) { return; }
    if (entry.audioEl) {
      entry.audioEl.srcObject = stream;
      return;
    }
    var audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = stream;
    document.body.appendChild(audio);
    entry.audioEl = audio;
    audio.play().catch(function () { /* 自动播放限制由手势解锁 */ });
  }

  // 解锁自动播放（首次 PTT 按下时调用）
  function unlockAudio() {
    Object.keys(peers).forEach(function (id) {
      var el = peers[id].audioEl;
      if (el) { el.play().catch(function () {}); }
    });
  }

  function initiate(remoteId) {
    var pc = createPeer(remoteId);
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      send({ type: 'webrtc_offer', to: remoteId, data: { sdp: pc.localDescription } });
    }).catch(function (e) { console.error('offer 失败', e); });
  }

  // 已建立连接后再挂入音轨需重新协商
  function negotiate(remoteId) {
    var entry = peers[remoteId];
    if (!entry) { return Promise.resolve(); }
    return entry.pc.createOffer().then(function (offer) {
      return entry.pc.setLocalDescription(offer);
    }).then(function () {
      send({ type: 'webrtc_offer', to: remoteId, data: { sdp: entry.pc.localDescription } });
    }).catch(function (e) { console.error('renegotiate 失败', e); });
  }

  function handleOffer(from, data) {
    var pc = createPeer(from);
    return pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () {
        send({ type: 'webrtc_answer', to: from, data: { sdp: pc.localDescription } });
      })
      .catch(function (e) { console.error('answer 失败', e); });
  }

  function handleAnswer(from, data) {
    var entry = peers[from];
    if (!entry) { return Promise.resolve(); }
    return entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .catch(function (e) { console.error('setRemoteDescription 失败', e); });
  }

  function handleIce(from, data) {
    var entry = peers[from];
    if (!entry) { return Promise.resolve(); }
    return entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate))
      .catch(function (e) { console.error('addIceCandidate 失败', e); });
  }

  // 开始按住说话
  function talkStart() {
    return ensureMic().then(function () {
      unlockAudio();
      // 确保所有 peer 都挂上了音轨；新挂上的需要重新协商
      Object.keys(peers).forEach(function (id) {
        var entry = peers[id];
        if (!entry.attached) {
          attachTracks(id);
          negotiate(id);
        }
      });
      if (localStream) {
        localStream.getAudioTracks().forEach(function (t) { t.enabled = true; });
      }
      send({ type: 'speaking', data: { talking: true } });
      if (onStateChange) { onStateChange(true); }
    }).catch(function () {
      throw new Error('无法使用麦克风');
    });
  }

  // 松开停止说话
  function talkStop() {
    if (localStream) {
      localStream.getAudioTracks().forEach(function (t) { t.enabled = false; });
    }
    send({ type: 'speaking', data: { talking: false } });
    if (onStateChange) { onStateChange(false); }
  }

  function getStream() { return localStream; }

  function removePeer(id) {
    var entry = peers[id];
    if (entry) {
      if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
      entry.pc.close();
      delete peers[id];
    }
  }

  function closeAll() {
    Object.keys(peers).forEach(removePeer);
    if (localStream) {
      localStream.getTracks().forEach(function (t) { t.stop(); });
      localStream = null;
    }
    micGranted = false;
  }

  return {
    setIce: setIce,
    setStateCallback: setStateCallback,
    initiate: initiate,
    negotiate: negotiate,
    handleOffer: handleOffer,
    handleAnswer: handleAnswer,
    handleIce: handleIce,
    talkStart: talkStart,
    talkStop: talkStop,
    removePeer: removePeer,
    closeAll: closeAll,
    getStream: getStream
  };
})();
