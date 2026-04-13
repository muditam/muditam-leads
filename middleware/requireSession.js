module.exports = function requireSession(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};