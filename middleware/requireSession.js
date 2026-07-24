module.exports = function requireSession(req, res, next) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  req.sessionUser = req.session.user;
  return next();
};
