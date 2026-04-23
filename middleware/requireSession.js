module.exports = function requireSession(req, res, next) {
  try {
    const headerUser = req.headers["x-session-user"];
    if (headerUser) {
      const parsed = JSON.parse(headerUser);
      if (parsed && (parsed.fullName || parsed.name || parsed.email || parsed.id)) {
        req.sessionUser = parsed;
        return next();
      }
    }
  } catch (_) {
    // ignore malformed header and continue with session check
  }

  if (req.session && req.session.user) {
    req.sessionUser = req.session.user;
    return next();
  }

  return res.status(401).json({ message: "Unauthorized" });
};
