const express = require("express");

const healthRouter = require("./health");
const complaintsRouter = require("./complaints");
const twilioRouter = require("./twilio");

const router = express.Router();

router.use("/health", healthRouter);
router.use("/complaints", complaintsRouter);
router.use("/twilio", twilioRouter);

module.exports = router;
