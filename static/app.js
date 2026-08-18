/* 网页对讲机主控制器 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var state = {
    me: null,
    room: null,          // {id, name}
    ws: null,
    wsReady: false,
    joining: false,        // 是否刚发送 join 等待首个 presence（用于发起 WebRTC offer）
    members: [],         // [{id, username}]
    speaking: {},        // userId -> true/false
    loadingOlder: false,
    hasMore: true,
    lastMsgId: 0,
    firstMsgId: Infinity,
    renderedIds: {},     // 已渲染的消息 id（去重）
    ttsMsgId: null,      // 当前正在朗读的消息 id
    recording: null,     // Voice.record() 句柄
    pttHolding: false,
    iceConfig: { iceServers: [] }
  };

  /* ---------------- API ---------------- */
  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { throw new Error(data.error || '请求失败'); }
        return data;
      });
    });
  }

  /* ---------------- 认证 ---------------- */
  function checkAuth() {
    return api('/api/me').then(function (data) {
      state.me = data;
      return data;
    }).catch(function () {
      window.location.href = '/login';
      throw new Error('未登录');
    });
  }

  /* ---------------- WebSocket ---------------- */
  function connectWS() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/ws');
    state.ws = ws;

    ws.onopen = function () {
      state.wsReady = true;
      if (state.room) {
        state.joining = true;
        sendWS({ type: 'join', room: state.room.id });
      }
    };
    ws.onclose = function () {
      state.wsReady = false;
      window.PTT.closeAll();
      setTimeout(function () { if (!state.me) { return; } connectWS(); }, 2000);
    };
    ws.onerror = function () { ws.close(); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleWS(msg);
    };
  }

  function sendWS(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }
  window.PTT.send = sendWS;

  function handleWS(msg) {
    var d = msg.data;
    switch (msg.type) {
      case 'presence':
        state.members = d || [];
        state.speaking = {};
        renderMembers();
        // 刚加入者向房间内其他成员发起 WebRTC offer（mesh 建连）
        if (state.joining) {
          state.joining = false;
          state.members.forEach(function (m) {
            if (m.id !== state.me.id) { window.PTT.initiate(m.id); }
          });
        }
        break;
      case 'user_joined':
        appendSys(msg.data.username + ' 加入了房间');
        break;
      case 'user_left':
        appendSys(msg.data.username + ' 离开了房间');
        window.PTT.removePeer(msg.data.id);
        state.members = state.members.filter(function (m) { return m.id !== msg.data.id; });
        renderMembers();
        break;
      case 'speaking':
        state.speaking[msg.data.id] = !!msg.data.talking;
        renderMembers();
        if (msg.data.id !== state.me.id && msg.data.talking) {
          var spk = state.members.find(function (m) { return m.id === msg.data.id; });
          appendSys((spk ? spk.username : '成员 ' + msg.data.id) + ' 正在说话…', true);
        }
        break;
      case 'chat':
        addMessage({ id: d.id, user_id: d.user_id, username: d.username, type: 'text', content: d.content, created_at: d.created_at });
        break;
      case 'voice':
        addMessage({ id: d.id, user_id: d.user_id, username: d.username, type: 'voice', content: d.content, audio_url: d.audio_url, duration: d.duration, created_at: d.created_at });
        break;
      case 'webrtc_offer':
        window.PTT.handleOffer(msg.from, d);
        break;
      case 'webrtc_answer':
        window.PTT.handleAnswer(msg.from, d);
        break;
      case 'webrtc_ice':
        window.PTT.handleIce(msg.from, d);
        break;
      case 'server_close':
        window.location.href = '/login';
        break;
      case 'room_deleted':
        if (state.room && msg.data && msg.data.id === state.room.id) {
          alert('房间已被房主删除');
          leaveRoom();
        } else {
          loadRooms();
        }
        break;
    }
  }

  /* ---------------- 大厅 ---------------- */
  function loadRooms() {
    var listEl = $('room-list');
    api('/api/rooms').then(function (data) {
      var rooms = data.rooms || [];
      if (!rooms.length) {
        listEl.innerHTML = '<div class="empty">还没有加入任何房间<br>创建一个或输入房间 ID 加入</div>';
        return;
      }
      listEl.innerHTML = rooms.map(function (r) {
        var isOwner = r.owner_id === state.me.id;
        return '<div class="room-item" data-id="' + r.id + '">' +
          '<div class="room-main"><div class="name">' + esc(r.name) + '</div>' +
          '<div class="meta">ID: ' + r.id + ' · 成员 ' + r.member_count + '</div></div>' +
          '<div class="room-ops">' +
          (isOwner ? '<button class="op-btn op-del" data-del="' + r.id + '">删除</button>' : '') +
          '<button class="op-btn op-leave" data-leave="' + r.id + '">退出</button>' +
          '</div></div>';
      }).join('');
      listEl.querySelectorAll('.room-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target.closest('.op-btn')) { return; }
          enterRoom(parseInt(el.dataset.id, 10));
        });
      });
      bindRoomOps(listEl);
    }).catch(function (err) {
      listEl.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });

    // 全部房间（可加入任意房间）
    var allEl = $('all-rooms');
    api('/api/rooms/all').then(function (data) {
      var rooms = data.rooms || [];
      if (!rooms.length) {
        allEl.innerHTML = '<div class="empty">暂无房间</div>';
        return;
      }
      allEl.innerHTML = rooms.map(function (r) {
        return '<div class="room-item" data-id="' + r.id + '">' +
          '<div class="room-main"><div class="name">' + esc(r.name) + '</div>' +
          '<div class="meta">ID: ' + r.id + ' · 成员 ' + r.member_count + '</div></div>' +
          '<div class="room-ops"><button class="op-btn op-join" data-join="' + r.id + '">加入</button></div></div>';
      }).join('');
      allEl.querySelectorAll('.room-item').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target.closest('.op-btn')) { return; }
          enterRoom(parseInt(el.dataset.id, 10));
        });
      });
    }).catch(function (err) {
      allEl.innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    });
  }

  // 绑定房间操作按钮：删除 / 退出 / 加入
  function bindRoomOps(listEl) {
    listEl.querySelectorAll('.op-del').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = parseInt(btn.dataset.del, 10);
        if (!confirm('确认删除该房间？将删除所有聊天记录与语音，且不可恢复！')) { return; }
        api('/api/rooms/' + id, { method: 'DELETE' }).then(function () {
          loadRooms();
        }).catch(function (err) { alert(err.message); });
      });
    });
    listEl.querySelectorAll('.op-leave').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = parseInt(btn.dataset.leave, 10);
        if (!confirm('确认退出该房间？')) { return; }
        api('/api/rooms/' + id + '/leave', { method: 'POST' }).then(function () {
          loadRooms();
        }).catch(function (err) { alert(err.message); });
      });
    });
    listEl.querySelectorAll('.op-join').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        enterRoom(parseInt(btn.dataset.join, 10));
      });
    });
  }

  function createRoom() {
    var name = $('create-name').value.trim();
    if (!name) { $('create-name').focus(); return; }
    api('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    }).then(function (r) {
      $('create-name').value = '';
      enterRoom(r.id);
    }).catch(function (err) { alert(err.message); });
  }

  function joinById() {
    var id = parseInt($('join-id').value, 10);
    if (!id) { $('join-id').focus(); return; }
    api('/api/rooms/' + id + '/join', { method: 'POST' })
      .then(function () { enterRoom(id); })
      .catch(function (err) { alert(err.message); });
  }

  /* ---------------- 房间 ---------------- */
  function enterRoom(id) {
    api('/api/rooms/' + id + '/join', { method: 'POST' }).then(function (r) {
      state.room = { id: r.id, name: r.name };
      $('room-title').textContent = r.name;
      $('view-lobby').classList.add('hidden');
      $('view-room').classList.remove('hidden');
      state.members = [];
      state.speaking = {};
      state.lastMsgId = 0;
      state.firstMsgId = Infinity;
      state.hasMore = true;
      state.renderedIds = {};
      $('messages').innerHTML = '';
      renderMembers();
      loadMessages();
      $('btn-ptt').disabled = false;
      if (state.wsReady) {
        state.joining = true;
        sendWS({ type: 'join', room: r.id });
      } else { connectWS(); }
    }).catch(function (err) { alert(err.message); });
  }

  function leaveRoom() {
    if (state.wsReady && state.room) { sendWS({ type: 'leave', room: state.room.id }); }
    window.PTT.closeAll();
    state.room = null;
    state.joining = false;
    $('messages').innerHTML = '';
    $('view-room').classList.add('hidden');
    $('view-lobby').classList.remove('hidden');
    $('btn-ptt').disabled = true;
    loadRooms();
  }

  function loadMessages(before) {
    if (!state.room) { return; }
    var url = '/api/rooms/' + state.room.id + '/messages?limit=50';
    if (before) { url += '&before=' + before; }
    api(url).then(function (data) {
      var msgs = data.messages || [];
      state.hasMore = !!data.has_more;
      var container = $('messages');
      if (before) {
        // 追加到顶部
        var olderDiv = $('load-older');
        if (olderDiv) { olderDiv.remove(); }
        var frag = document.createElement('div');
        msgs.forEach(function (m) { frag.appendChild(buildMessageEl(m)); });
        container.insertBefore(frag, container.firstChild);
        if (msgs.length) { state.firstMsgId = msgs[0].id; }
        renderLoadMore();
      } else {
        container.innerHTML = '';
        msgs.forEach(function (m) { addMessage(m, true); });
        container.scrollTop = container.scrollHeight;
      }
    }).catch(function (err) { console.error(err); });
  }

  function renderLoadMore() {
    var existing = $('load-older');
    if (existing) { existing.remove(); }
    if (state.hasMore) {
      var div = document.createElement('div');
      div.id = 'load-older';
      div.className = 'load-more';
      div.innerHTML = '<button>加载更早消息</button>';
      div.querySelector('button').addEventListener('click', function () {
        if (!state.loadingOlder && state.firstMsgId < Infinity) {
          state.loadingOlder = true;
          loadMessages(state.firstMsgId).finally(function () { state.loadingOlder = false; });
        }
      });
      $('messages').insertBefore(div, $('messages').firstChild);
    }
  }

  function appendSys(text, highlight) {
    var div = document.createElement('div');
    div.className = 'sys-msg' + (highlight ? ' speaking' : '');
    div.textContent = text;
    $('messages').appendChild(div);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  /* ---------------- 消息渲染 ---------------- */
  function addMessage(m, isHistory) {
    if (m.id && state.renderedIds[m.id]) { return; }
    if (m.id) { state.renderedIds[m.id] = true; }
    var el = buildMessageEl(m);
    $('messages').appendChild(el);
    if (!isHistory) { $('messages').scrollTop = $('messages').scrollHeight; }
    // 文字消息自动朗读（仅实时消息，且开启）
    if (m.type === 'text' && !isHistory && m.user_id !== state.me.id) {
      state.ttsMsgId = m.id;
      window.Voice.speak(m.content);
    }
    if (m.id > state.lastMsgId) { state.lastMsgId = m.id; }
    if (m.id < state.firstMsgId) { state.firstMsgId = m.id; }
    renderLoadMore();
  }

  function buildMessageEl(m) {
    var mine = m.user_id === state.me.id;
    var div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'mine' : 'other') + (m.type === 'voice' ? ' voice' : '');
    div.dataset.id = m.id;

    var inner = '';
    inner += '<div class="sender">' + esc(m.username) + '</div>';
    if (m.type === 'text') {
      inner += '<div class="text">' + esc(m.content) + '</div>';
      if (mine && window.Voice.isTTS()) {
        inner += '<div class="tts-play" data-text="' + esc(m.content) + '">▶ 播放语音</div>';
      }
    } else {
      var dur = (m.duration && m.duration > 0) ? m.duration.toFixed(1) + 's' : '';
      inner += '<div class="voice-btn" data-url="' + esc(m.audio_url) + '">' +
        '<span class="voice-icon">🔊</span><span class="voice-dur">' + dur + '</span></div>';
      var hasTranscript = m.content && m.content.trim().length > 0;
      if (hasTranscript) {
        inner += '<div class="transcript"><span class="transcript-tag">[转文字]</span>' + esc(m.content) + '</div>';
      } else if (window.Voice.browserASR()) {
        inner += '<div class="no-transcript">📝 无转写文本（浏览器语音识别未返回内容）</div>';
      } else {
        inner += '<div class="no-transcript">📝 该浏览器不支持实时转写</div>';
      }
    }
    inner += '<div class="time">' + esc(formatTime(m.created_at)) + '</div>';
    div.innerHTML = inner;

    var vb = div.querySelector('.voice-btn');
    if (vb) {
      vb.addEventListener('click', function () {
        var url = vb.dataset.url;
        var el = document.createElement('audio');
        el.src = url;
        el.onended = function () { vb.classList.remove('playing'); el.remove(); };
        el.onerror = function () { vb.classList.remove('playing'); el.remove(); };
        vb.classList.add('playing');
        el.play();
      });
    }
    var tp = div.querySelector('.tts-play');
    if (tp) {
      tp.addEventListener('click', function () {
        state.ttsMsgId = m.id;
        window.Voice.speakOnce(tp.dataset.text);
      });
    }
    return div;
  }

  function formatTime(ts) {
    if (!ts) { return ''; }
    return String(ts).slice(5, 16);
  }

  /* ---------------- 播放/朗读动态指示 ---------------- */
  function setNowPlaying(playing, text) {
    var np = $('now-playing');
    if (!np) { return; }
    if (playing) {
      $('now-playing-text').textContent = text ? '正在朗读：' + text : '正在播放';
      np.classList.remove('hidden');
      if (state.ttsMsgId) {
        var el = document.querySelector('.msg[data-id="' + state.ttsMsgId + '"]');
        if (el) { el.classList.add('tts-playing'); }
      }
    } else {
      np.classList.add('hidden');
      var all = document.querySelectorAll('.msg.tts-playing');
      for (var i = 0; i < all.length; i++) { all[i].classList.remove('tts-playing'); }
    }
  }

  /* ---------------- 成员 ---------------- */
  function renderMembers() {
    var listEl = $('members-list');
    var count = state.members.length;
    $('member-count').textContent = count;
    if (listEl) {
      listEl.innerHTML = state.members.map(function (m) {
        var isMe = m.id === state.me.id;
        var spk = state.speaking[m.id] ? '<span class="member-speaking">● 说话中</span>' : '';
        return '<li><span class="dot online"></span>' +
          '<span class="member-name">' + esc(m.username) + '</span>' +
          spk +
          (isMe ? '<span class="member-me">(我)</span>' : '') + '</li>';
      }).join('');
      if (!state.members.length) {
        listEl.innerHTML = '<li style="color:var(--text-dim)">暂无在线成员</li>';
      }
    }
  }

  /* ---------------- 文字发送 ---------------- */
  function sendText() {
    var input = $('text-input');
    var text = input.value.trim();
    if (!text || !state.room) { return; }
    api('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: state.room.id, content: text })
    }).then(function (m) {
      input.value = '';
      addMessage(m);
    }).catch(function (err) { alert(err.message); });
  }

  /* ---------------- PTT 对讲 ---------------- */
  function initPTT() {
    var btn = $('btn-ptt');
    function press() {
      if (!state.room || state.pttHolding) { return; }
      state.pttHolding = true;
      btn.classList.add('holding');
      window.PTT.talkStart().catch(function () {
        state.pttHolding = false;
        btn.classList.remove('holding');
        if (!window.isSecureContext) {
          alert('当前为 HTTP 访问，手机浏览器不允许使用麦克风。\n请通过 HTTPS 访问（如配置域名 + Caddy），详见 README。');
        } else {
          alert('无法使用麦克风，请检查浏览器权限设置（允许麦克风）。');
        }
      });
    }
    function release() {
      if (!state.pttHolding) { return; }
      state.pttHolding = false;
      btn.classList.remove('holding');
      window.PTT.talkStop();
    }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      press();
      // 捕获指针，防止手指滑出按钮时误松开发送
      if (btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (err) {} }
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ---------------- 语音消息录制 ---------------- */
  function startRecording() {
    $('voice-rec-modal').classList.remove('hidden');
    $('rec-wave').classList.remove('hidden');
    $('btn-voice-msg').classList.add('recording');
    $('btn-rec-send').disabled = true;
    $('rec-status').textContent = '正在请求麦克风…';
    $('rec-time').textContent = '0.0s';
    window.Voice.record().then(function (rec) {
      state.recording = rec;
      $('rec-status').textContent = '录制中…';
      var t0 = Date.now();
      var timer = setInterval(function () {
        $('rec-time').textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      }, 100);
      state.recTimer = timer;
      $('btn-rec-send').disabled = false;
    }).catch(function (err) {
      $('rec-status').textContent = '无法录音：' + err.message;
    });
  }

  function stopRecordingAndSend() {
    if (!state.recording) { return; }
    var rec = state.recording;
    state.recording = null;
    clearInterval(state.recTimer);
    $('rec-status').textContent = '正在处理…';
    $('btn-rec-send').disabled = true;
    rec.stop().then(function (result) {
      $('voice-rec-modal').classList.add('hidden');
      $('rec-wave').classList.add('hidden');
      $('btn-voice-msg').classList.remove('recording');
      uploadVoice(result);
    });
  }

  function cancelRecording() {
    if (state.recording) {
      state.recording.cancel();
      state.recording = null;
      clearInterval(state.recTimer);
    }
    $('voice-rec-modal').classList.add('hidden');
    $('rec-wave').classList.add('hidden');
    $('btn-voice-msg').classList.remove('recording');
  }

  function uploadVoice(result) {
    function buildFD(t) {
      var fd = new FormData();
      fd.append('room_id', state.room.id);
      fd.append('audio', result.blob, 'voice' + (result.blob.type.indexOf('mp4') >= 0 ? '.mp4' : '.webm'));
      fd.append('duration', result.duration.toFixed(1));
      fd.append('transcript', t || '');
      return fd;
    }
    function doUpload(t) {
      return api('/api/messages/voice', { method: 'POST', body: buildFD(t) })
        .then(function (m) { addMessage(m); })
        .catch(function (err) { alert('上传语音失败：' + err.message); });
    }
    var transcript = window.Voice.isASR() && result.transcript ? result.transcript : '';
    if (!transcript && window.Voice.isASR()) {
      // 浏览器识别为空（Edge/Safari 兼容性差）→ 尝试服务器端 ASR 兜底，未配置则忽略
      var fd = new FormData();
      fd.append('audio', result.blob, 'voice' + (result.blob.type.indexOf('mp4') >= 0 ? '.mp4' : '.webm'));
      return api('/api/asr', { method: 'POST', body: fd })
        .then(function (d) { return d.text || ''; })
        .catch(function () { return ''; })
        .then(function (t) { return doUpload(t); });
    }
    return doUpload(transcript);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    window.PTT.setStateCallback(function (talking) {
      if (talking) { renderMembers(); }
    });

    window.Voice.setSpeakListener(function (speaking, text) {
      setNowPlaying(speaking, text);
    });

    $('btn-logout').addEventListener('click', function () {
      api('/api/logout', { method: 'POST' }).finally(function () {
        window.location.href = '/login';
      });
    });
    $('btn-my').addEventListener('click', function () {
      $('me-username').textContent = state.me.username;
      $('me-id').textContent = 'ID: ' + state.me.id;
      $('me-modal').classList.remove('hidden');
    });
    $('btn-me-close').addEventListener('click', function () { $('me-modal').classList.add('hidden'); });
    $('btn-create').addEventListener('click', createRoom);
    $('btn-join-id').addEventListener('click', joinById);
    $('btn-back').addEventListener('click', leaveRoom);
    $('btn-send').addEventListener('click', sendText);
    $('text-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendText(); }
    });
    $('btn-members').addEventListener('click', function () { $('members-panel').classList.remove('hidden'); });
    $('btn-members-close').addEventListener('click', function () { $('members-panel').classList.add('hidden'); });

    $('chk-tts').addEventListener('change', function (e) { window.Voice.setTTS(e.target.checked); });
    $('chk-asr').addEventListener('change', function (e) { window.Voice.setASR(e.target.checked); });

    $('btn-voice-msg').addEventListener('click', function () {
      if (state.recording) { stopRecordingAndSend(); }
      else { startRecording(); }
    });
    $('btn-rec-send').addEventListener('click', stopRecordingAndSend);
    $('btn-rec-cancel').addEventListener('click', cancelRecording);

    initPTT();

    // ICE 配置
    api('/api/ice-config').then(function (d) {
      window.PTT.setIce(d.iceServers);
    }).catch(function () {});

    checkAuth().then(function () {
      $('app').classList.remove('hidden');
      loadRooms();
      connectWS();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
