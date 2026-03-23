/**
 * Returns an HTML login page for the OAuth authorize flow.
 *
 * The page handles three auth methods:
 * 1. Username/password — form POST to /auth/token
 * 2. Google Sign-In — Google Identity Services popup
 * 3. Apple Sign-In — (placeholder for future)
 *
 * After successful login, the page POSTs the JWT to /authorize/callback
 * which completes the OAuth code flow and redirects back to the MCP client.
 */
export function getAuthorizePage(params: {
  nonce: string;
  googleClientId: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Inistate</title>
  <script src="https://accounts.google.com/gsi/client" async></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #333;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.1);
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 8px;
    }
    .subtitle {
      text-align: center;
      color: #666;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .divider {
      display: flex;
      align-items: center;
      margin: 20px 0;
      color: #aaa;
      font-size: 13px;
    }
    .divider::before, .divider::after {
      content: "";
      flex: 1;
      border-bottom: 1px solid #ddd;
    }
    .divider::before { margin-right: 12px; }
    .divider::after { margin-left: 12px; }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
      color: #555;
    }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 15px;
      margin-bottom: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #4285f4; }
    .btn {
      width: 100%;
      padding: 11px;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-primary {
      background: #4285f4;
      color: #fff;
    }
    .btn-primary:hover { background: #3367d6; }
    .btn-primary:disabled {
      background: #a4c2f4;
      cursor: not-allowed;
    }
    #google-btn {
      display: flex;
      justify-content: center;
      margin-bottom: 8px;
    }
    .error {
      background: #fdecea;
      color: #c62828;
      padding: 10px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 14px;
      display: none;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #fff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Inistate</h1>
    <p class="subtitle">Connect your account to continue</p>

    <div id="google-btn"></div>

    <div class="divider">or sign in with email</div>

    <div id="error" class="error"></div>

    <form id="login-form" onsubmit="return handleLogin(event)">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@example.com">

      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Your password">

      <button type="submit" class="btn btn-primary" id="submit-btn">Sign in</button>
    </form>
  </div>

  <!-- Hidden form to POST result back to server -->
  <form id="callback-form" method="POST" action="/authorize/callback" style="display:none">
    <input type="hidden" name="nonce" value="${params.nonce}">
    <input type="hidden" name="jwt" id="cb-jwt">
    <input type="hidden" name="refreshToken" id="cb-refresh">
  </form>

  <script>
    const NONCE = "${params.nonce}";

    function showError(msg) {
      const el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }

    function setLoading(loading) {
      const btn = document.getElementById("submit-btn");
      btn.disabled = loading;
      btn.innerHTML = loading
        ? '<span class="spinner"></span>Signing in...'
        : "Sign in";
    }

    function completeAuth(token, refreshToken) {
      document.getElementById("cb-jwt").value = token;
      document.getElementById("cb-refresh").value = refreshToken || "";
      document.getElementById("callback-form").submit();
    }

    async function handleLogin(e) {
      e.preventDefault();
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      document.getElementById("error").style.display = "none";
      setLoading(true);

      try {
        const res = await fetch("/auth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          showError(data.message || data.error || "Login failed");
          setLoading(false);
          return;
        }
        completeAuth(data.token, data.refreshToken);
      } catch (err) {
        showError("Network error. Please try again.");
        setLoading(false);
      }
    }

    // Google Sign-In callback
    function handleGoogleCredential(response) {
      // response.credential is a Google ID token (JWT)
      // Send as accessToken to our external auth endpoint
      fetch("/auth/external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "google", accessToken: response.credential }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.token) {
            completeAuth(data.token, data.refreshToken);
          } else {
            showError(data.message || data.error || "Google login failed");
          }
        })
        .catch(() => showError("Google login failed. Please try again."));
    }

    // Initialize Google Identity Services
    window.onload = function () {
      if (typeof google !== "undefined" && google.accounts) {
        google.accounts.id.initialize({
          client_id: "${params.googleClientId}",
          callback: handleGoogleCredential,
        });
        google.accounts.id.renderButton(
          document.getElementById("google-btn"),
          { theme: "outline", size: "large", width: "320", text: "signin_with" }
        );
      }
    };
  </script>
</body>
</html>`;
}
