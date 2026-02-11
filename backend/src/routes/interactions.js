const express = require("express");

const {
  createChatInteraction,
  createVoiceInteraction,
} = require("../controllers/interactionController");

const router = express.Router();

router.post("/chat", createChatInteraction);
router.post("/voice", createVoiceInteraction);

module.exports = router;
