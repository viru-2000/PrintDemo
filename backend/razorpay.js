
//require('dotenv').config({ path: './payment.env' });
const Razorpay = require("razorpay");

module.exports = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID ,
  key_secret: process.env.RAZORPAY_KEY_SECRET ,



  //key_id: "rzp_test_SCYSNiFQ2dXJuu",
  //key_secret: "kdBRmQ6TLv1NIsxHsw8DczTc",
});
