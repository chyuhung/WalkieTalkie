/* 语音工具：文字自动朗读(TTS)、语音转文字(ASR)、语音消息录制 */
window.Voice = (function () {
  'use strict';

  var ttsEnabled = true;
  var asrEnabled = true;
  var speakListeners = [];

  /* ---------------- TTS 文字自动朗读 ---------------- */
  function setTTS(v) { ttsEnabled = v; if (!v) { stopSpeak(); } }
  function isTTS() { return ttsEnabled; }

  // 注册朗读状态回调（speaking 是否正在朗读，text 朗读内容）
  function setSpeakListener(fn) { speakListeners.push(fn); }
  function notifySpeak(speaking, text) {
    speakListeners.forEach(function (fn) { try { fn(speaking, text); } catch (e) {} });
  }

  function pickZhVoice() {
    if (!('speechSynthesis' in window)) { return null; }
    var voices = window.speechSynthesis.getVoices();
    return voices.find(function (v) { return /^zh(-|_)/.test(v.lang); }) || null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = function () {};
    pickZhVoice();
  }

  function speak(text) {
    if (!ttsEnabled || !text) { return false; }
    if (!('speechSynthesis' in window)) { return false; }
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.0;
    var zh = pickZhVoice();
    if (zh) { u.voice = zh; }
    u.onstart = function () { notifySpeak(true, text); };
    u.onend = function () { notifySpeak(false, text); };
    u.onerror = function () { notifySpeak(false, text); };
    window.speechSynthesis.speak(u);
    return true;
  }

  function speakOnce(text) {
    if (!text) { return; }
    var was = ttsEnabled;
    ttsEnabled = true;
    speak(text);
    ttsEnabled = was;
  }

  function stopSpeak() {
    if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); }
    notifySpeak(false);
  }

  /* ---------------- ASR 语音转文字（浏览器端） ---------------- */
  function setASR(v) { asrEnabled = v; }
  function isASR() { return asrEnabled; }
  function browserASR() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // 实时转写一次麦克风输入（按住录制时后台运行）
  // 返回 { rec, done }，done 在识别完全结束（onend）后 resolve，供 stop() 等待
  function transcribeLive(stream, onFinal, onError) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { if (onError) { onError(new Error('该浏览器不支持语音识别')); } return null; }
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    var result = '';
    var resolveDone = null;
    var done = new Promise(function (resolve) { resolveDone = resolve; });
    rec.onresult = function (e) {
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) { result += e.results[i][0].transcript; }
      }
      if (onFinal) { onFinal(result); }
    };
    rec.onerror = function (e) {
      // not-allowed / no-speech 等错误直接忽略，不影响录音本身
      if (e.error === 'no-speech' || e.error === 'not-allowed') { return; }
      if (onError) { onError(e.error); }
    };
    rec.onend = function () {
      if (onFinal) { onFinal(result); }
      if (resolveDone) { resolveDone(); resolveDone = null; }
    };
    try { rec.start(); } catch (e) { if (resolveDone) { resolveDone(); resolveDone = null; } }
    return { rec: rec, done: done };
  }

  // 录制语音消息（异步，返回 Promise<{blob, url, duration, transcript}>）
  function record() {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder === 'undefined') {
        stream.getTracks().forEach(function (t) { t.stop(); });
        throw new Error('该浏览器不支持录音');
      }
      var rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : undefined);
      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size > 0) { chunks.push(e.data); } };
      var stopPromise = new Promise(function (resolve) {
        rec.onstop = function () { resolve(); };
      });
      rec.start();
      var t0 = Date.now();
      var transcript = '';
      var asr = transcribeLive(stream, function (t) { transcript = t; }, function () {});
      return {
        stop: function () {
          var duration = (Date.now() - t0) / 1000;
          rec.stop();
          if (asr && asr.rec) { try { asr.rec.stop(); } catch (e) {} }
          stream.getTracks().forEach(function (t) { t.stop(); });
          // 等待 MediaRecorder 停止 和 语音识别结束（最终结果在 onend 前到达）。
          // 部分浏览器（Edge/Safari）识别可能永不触发 onend，加超时兜底避免一直等待。
          var waitAsr;
          if (asr && asr.done) {
            waitAsr = Promise.race([asr.done, new Promise(function (resolve) { setTimeout(resolve, 1500); })]);
          } else {
            waitAsr = Promise.resolve();
          }
          return Promise.all([stopPromise, waitAsr]).then(function () {
            var blob = new Blob(chunks, { type: rec.mimeType || mime });
            return { blob: blob, url: URL.createObjectURL(blob), duration: duration, transcript: transcript.trim() };
          });
        },
        cancel: function () {
          if (asr && asr.rec) { try { asr.rec.stop(); } catch (e) {} }
          stream.getTracks().forEach(function (t) { t.stop(); });
          rec.stop();
        }
      };
    });
  }

  return {
    setTTS: setTTS, isTTS: isTTS,
    speak: speak, speakOnce: speakOnce, stopSpeak: stopSpeak, setSpeakListener: setSpeakListener,
    setASR: setASR, isASR: isASR, browserASR: browserASR,
    transcribeLive: transcribeLive,
    record: record
  };
})();
