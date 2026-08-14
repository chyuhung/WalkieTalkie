/* 语音工具：文字自动朗读(TTS)、语音转文字(ASR)、语音消息录制 */
window.Voice = (function () {
  'use strict';

  var ttsEnabled = true;
  var asrEnabled = true;

  /* ---------------- TTS 文字自动朗读 ---------------- */
  function setTTS(v) { ttsEnabled = v; if (!v) { stopSpeak(); } }
  function isTTS() { return ttsEnabled; }

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
  }

  /* ---------------- ASR 语音转文字（浏览器端） ---------------- */
  function setASR(v) { asrEnabled = v; }
  function isASR() { return asrEnabled; }
  function browserASR() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // 实时转写一次麦克风输入（按住录制时后台运行）
  function transcribeLive(stream, onFinal, onError) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { if (onError) { onError(new Error('该浏览器不支持语音识别')); } return null; }
    var rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    var result = '';
    rec.onresult = function (e) {
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) { result += e.results[i][0].transcript; }
      }
      if (onFinal) { onFinal(result); }
    };
    rec.onerror = function (e) {
      // not-allowed 等错误直接忽略，不影响录音本身
      if (e.error === 'no-speech') { return; }
      if (onError) { onError(e.error); }
    };
    rec.onend = function () {
      if (onFinal) { onFinal(result); }
    };
    try { rec.start(); } catch (e) {}
    return rec;
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
      var asrRec = transcribeLive(stream, function (t) { transcript = t; }, function () {});
      return {
        stop: function () {
          var duration = (Date.now() - t0) / 1000;
          rec.stop();
          if (asrRec) { try { asrRec.stop(); } catch (e) {} }
          stream.getTracks().forEach(function (t) { t.stop(); });
          return stopPromise.then(function () {
            var blob = new Blob(chunks, { type: rec.mimeType || mime });
            return { blob: blob, url: URL.createObjectURL(blob), duration: duration, transcript: transcript.trim() };
          });
        },
        cancel: function () {
          if (asrRec) { try { asrRec.stop(); } catch (e) {} }
          stream.getTracks().forEach(function (t) { t.stop(); });
          rec.stop();
        }
      };
    });
  }

  return {
    setTTS: setTTS, isTTS: isTTS,
    speak: speak, speakOnce: speakOnce, stopSpeak: stopSpeak,
    setASR: setASR, isASR: isASR, browserASR: browserASR,
    transcribeLive: transcribeLive,
    record: record
  };
})();
