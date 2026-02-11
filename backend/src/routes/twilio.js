const express = require("express");

const { intakeSms } = require("../controllers/intakeController");

const router = express.Router();

router.post("/sms", intakeSms);

module.exports = router;
