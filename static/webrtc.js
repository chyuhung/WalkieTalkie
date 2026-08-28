/* WebRTC P2P 实时对讲（mesh 拓扑）
 * 依赖：window.PTT.send 需由 app.js 注入 WebSocket 发送函数
 */
window.PTT = (function () {
  'use strict';

  var peers = {};            // userId -> { pc, senderTracks, audioEl, attached }
  var localStream = null;
  var micGranted = false;
  var iceConfig = { iceServers: [] };
  var onStateChange = null;  // 回调，通知 UI 某成员说话状态
  var onConnFail = null;     // 回调，通知 UI 某成员语音连接失败
  var pendingOffers = {};    // userId -> 暂存无法立即处理的 offer（防 glare）
  var pendingPlays = {};     // userId -> 远端音频被自动播放拦截，待手势解锁

  function send(obj) {
    if (window.PTT.send && window.PTT.send(obj)) { /* ok */ }
  }

  function setIce(servers) {
    if (Array.isArray(servers)) { iceConfig.iceServers = servers; }
  }

  function setStateCallback(fn) { onStateChange = fn; }
  function setConnFailCallback(fn) { onConnFail = fn; }

  // 该 peer 是否已挂上并仍有活跃的音轨（用于判断是否需要补协商）
  function hasLiveAudio(entry) {
    return !!(entry && entry.attached && entry.senderTracks.length &&
      entry.senderTracks.every(function (t) { return t.readyState === 'live'; }));
  }

  // 补挂/补协商：把当前尚未带音轨的 peer 挂上音轨并重发 offer，让音频进入已建立的连接
  function ensureTracksEverywhere() {
    Object.keys(peers).forEach(function (id) {
      var entry = peers[id];
      var hadLive = hasLiveAudio(entry);
      if (!entry.attached && localStream) { attachTracks(id); }
      // 之前无音轨（建连早于麦克风就绪）或音轨已失效 → 需要通过重协商补进 SDP
      if (!hadLive && hasLiveAudio(entry)) { negotiate(id); }
    });
  }

  // 获取麦克风流（复用，避免每次按住说话都弹权限框）
  function ensureMic() {
    if (micGranted) { return Promise.resolve(localStream); }
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      localStream = stream;
      micGranted = true;
      // 创建 PC 后获取到的流，需补挂到已有 peer；建连早于麦克风就绪的需重协商补音频
      ensureTracksEverywhere();
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
    // 信令回到 stable 后处理排队中的 offer（防 glare）
    pc.onsignalingstatechange = function () {
      if (pc.signalingState === 'stable' && pendingOffers[remoteId]) {
        var d = pendingOffers[remoteId];
        delete pendingOffers[remoteId];
        doAnswer(remoteId, d);
      }
    };
    pc.onconnectionstatechange = function () {
      console.log('PTT 连接状态 [' + remoteId + ']:', pc.connectionState);
      if (pc.connectionState === 'failed' && onConnFail) {
        onConnFail(remoteId);
        restartIce(remoteId);
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
    audio.setAttribute('playsinline', '');
    audio.srcObject = stream;
    document.body.appendChild(audio);
    entry.audioEl = audio;
    tryPlay(remoteId);
  }

  // 播放远端音频；被自动播放策略拦截则记录，待用户手势后重试
  function tryPlay(remoteId) {
    var entry = peers[remoteId];
    if (!entry || !entry.audioEl) { return; }
    entry.audioEl.play().then(function () {
      delete pendingPlays[remoteId];
    }).catch(function () {
      pendingPlays[remoteId] = true;
    });
  }

  // 重试所有被拦截的播放（需在用户手势内调用：任意点击 / 按 PTT）
  function unlockAudio() {
    if (!Object.keys(pendingPlays).length) { return; }
    Object.keys(pendingPlays).forEach(tryPlay);
  }

  // 任意点击页面即可解锁移动端远端音频播放
  document.addEventListener('pointerdown', unlockAudio);

  // 等待信令状态回到 stable 再继续，避免协商冲突（glare）
  function whenStable(pc) {
    if (pc.signalingState === 'stable') { return Promise.resolve(); }
    return new Promise(function (resolve) {
      var h = function () {
        if (pc.signalingState === 'stable') {
          pc.removeEventListener('signalingstatechange', h);
          resolve();
        }
      };
      pc.addEventListener('signalingstatechange', h);
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

  // 已建立连接后再挂入音轨需重新协商；仅 stable 时发起，防止 glare
  function negotiate(remoteId) {
    var entry = peers[remoteId];
    if (!entry) { return Promise.resolve(); }
    var pc = entry.pc;
    return whenStable(pc).then(function () {
      return pc.createOffer();
    }).then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      send({ type: 'webrtc_offer', to: remoteId, data: { sdp: pc.localDescription } });
    }).catch(function (e) { console.error('renegotiate 失败', e); });
  }

  // 应答对方 offer（音轨在 createPeer 时已挂上，answer 自带音频，无需再协商）
  function doAnswer(from, data) {
    var pc = peers[from] && peers[from].pc;
    if (!pc) { return Promise.resolve(); }
    return pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () {
        send({ type: 'webrtc_answer', to: from, data: { sdp: pc.localDescription } });
      })
      .catch(function (e) {
        console.error('answer 失败', e);
        delete pendingOffers[from];
      });
  }

  function handleOffer(from, data) {
    var pc = createPeer(from);
    // 本端有协商在途：先排队，等回到 stable 再应答（防 glare）
    if (pc.signalingState !== 'stable') {
      pendingOffers[from] = data;
      return Promise.resolve();
    }
    return doAnswer(from, data);
  }

  function handleAnswer(from, data) {
    var entry = peers[from];
    // 仅在等待 answer 的状态下接受，防止杂散消息破坏状态机
    if (!entry || entry.pc.signalingState !== 'have-local-offer') { return Promise.resolve(); }
    return entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .catch(function (e) { console.error('setRemoteDescription 失败', e); });
  }

  // ICE 连接失败后的重试：标记 restart 并重发 offer
  function restartIce(remoteId) {
    var entry = peers[remoteId];
    if (!entry || !entry.pc.restartIce) { return; }
    try { entry.pc.restartIce(); } catch (e) {}
    negotiate(remoteId);
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
      // 确保所有 peer 都挂上且协商了活跃音轨；缺失的补挂并重协商
      Object.keys(peers).forEach(function (id) {
        var entry = peers[id];
        if (!entry.attached && localStream) { attachTracks(id); }
        if (!hasLiveAudio(entry)) { negotiate(id); }
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
    setConnFailCallback: setConnFailCallback,
    ensureMic: ensureMic,
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
