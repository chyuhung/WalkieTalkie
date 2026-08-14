(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { throw new Error(data.error || '请求失败'); }
        return data;
      });
    });
  }

  function showError(id, msg) {
    var el = $(id);
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // 登录页
  var loginBtn = $('btn-login');
  if (loginBtn) {
    loginBtn.addEventListener('click', function () {
      var username = $('login-username').value.trim();
      var password = $('login-password').value;
      if (!username || !password) { showError('login-error', '请输入用户名和密码'); return; }
      loginBtn.disabled = true;
      loginBtn.textContent = '登录中…';
      api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function () {
        window.location.href = '/';
      }).catch(function (err) {
        showError('login-error', err.message);
      }).finally(function () {
        loginBtn.disabled = false;
        loginBtn.textContent = '登 录';
      });
    });
  }

  // 注册页
  var regBtn = $('btn-register');
  if (regBtn) {
    regBtn.addEventListener('click', function () {
      var username = $('reg-username').value.trim();
      var password = $('reg-password').value;
      var password2 = $('reg-password2').value;
      if (!username || !password) { showError('reg-error', '请填写用户名和密码'); return; }
      if (password !== password2) { showError('reg-error', '两次输入的密码不一致'); return; }
      regBtn.disabled = true;
      regBtn.textContent = '注册中…';
      api('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function () {
        window.location.href = '/';
      }).catch(function (err) {
        showError('reg-error', err.message);
      }).finally(function () {
        regBtn.disabled = false;
        regBtn.textContent = '注 册';
      });
    });
  }

  // 回车提交
  function bindEnter(inputId, btnId) {
    var input = $(inputId);
    if (!input) { return; }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var btn = $(btnId); if (btn) { btn.click(); } }
    });
  }
  bindEnter('login-password', 'btn-login');
  bindEnter('reg-password2', 'btn-register');
})();
