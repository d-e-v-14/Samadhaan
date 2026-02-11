const express = require("express");

const {
  createComplaint,
  readComplaint,
  deleteComplaint,
} = require("../controllers/complaintController");

const router = express.Router();

router.post("/createComplaints/", createComplaint);
router.get("/readComplaints/:complaint_no", readComplaint);
router.delete("/deleteComplaints/:complaint_id", deleteComplaint);

module.exports = router;
