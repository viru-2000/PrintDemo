
//require('dotenv').config({ path: './payment.env' });
// const Razorpay = require("razorpay");

// module.exports = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID ,
//   key_secret: process.env.RAZORPAY_KEY_SECRET ,

// ${{ secret() }}

let razorpay = null;

if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} else {
  console.warn("⚠️ Razorpay keys missing — payments disabled");
}

if (!razorpay) {
  return res.status(500).json({ error: "Payment service unavailable" });
}


  //key_id: "rzp_test_SCYSNiFQ2dXJuu",
  //key_secret: "kdBRmQ6TLv1NIsxHsw8DczTc",
// });
