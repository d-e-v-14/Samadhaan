const express = require("express");

const healthRouter = require("./health");
const authRouter = require("./auth");
const complaintsRouter = require("./complaints");
const assignmentsRouter = require("./assignments");
const mediaRouter = require("./media");
const notificationsRouter = require("./notifications");
const aiRouter = require("./ai");
const citizensRouter = require("./citizens");
const interactionsRouter = require("./interactions");
const { requireAuth } = require("../middlewares/auth");

const router = express.Router();

router.use("/health", healthRouter);
router.use("/auth", authRouter);

router.use(requireAuth);
router.use("/complaints", complaintsRouter);
router.use("/assignments", assignmentsRouter);
router.use("/media", mediaRouter);
router.use("/notifications", notificationsRouter);
router.use("/ai", aiRouter);
router.use("/citizens", citizensRouter);
router.use("/interactions", interactionsRouter);

module.exports = router;
