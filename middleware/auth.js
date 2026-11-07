// Where each role lands after logging in
function homePathFor(user) {
  return user.role === 'admin' ? '/admin' : '/dashboard';
}

// Only logged-in users may continue
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'warning', message: 'Please log in to continue.' };
    return res.redirect('/login');
  }
  next();
}

// Only logged-in users with the given role may continue: requireRole('admin')
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      req.session.flash = { type: 'warning', message: 'Please log in to continue.' };
      return res.redirect('/login');
    }
    if (req.session.user.role !== role) {
      return res.status(403).render('errors/403');
    }
    next();
  };
}

// Logged-in users do not need the login or register pages
function redirectIfLoggedIn(req, res, next) {
  if (req.session.user) return res.redirect(homePathFor(req.session.user));
  next();
}

module.exports = { homePathFor, requireLogin, requireRole, redirectIfLoggedIn };