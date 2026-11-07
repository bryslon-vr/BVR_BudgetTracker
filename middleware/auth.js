// Only logged-in users may continue
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'warning', message: 'Please log in to continue.' };
    return res.redirect('/login');
  }
  next();
}

// Logged-in users do not need the login or register pages
function redirectIfLoggedIn(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  next();
}

module.exports = { requireLogin, redirectIfLoggedIn };