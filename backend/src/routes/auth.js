const express = require("express");

const {
  requestOtp,
  verifyOtp,
  refreshSession,
  getCurrentUser,
  logout,
} = require("../controllers/authController");
const { requireAuth } = require("../middlewares/auth");

const router = express.Router();

router.post("/otp/request", requestOtp);
router.post("/otp/verify", verifyOtp);
router.post("/refresh", refreshSession);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, getCurrentUser);

module.exports = router;
