// steps/StepOTP.jsx
import React from "react";
import { QRCodeCanvas } from "qrcode.react";

export default function StepOTP({ otp, qrToken, jobSuccess, jobError }) {
  return (
    <div className="pf-step-enter">
      <p className="pf-section-title">// collect your prints</p>

      {jobSuccess ? (
        <div className="pf-alert success">✓ {jobSuccess}</div>
      ) : null}

      {jobError ? (
        <div className="pf-alert error">⚠ {jobError}</div>
      ) : null}

      <div className="pf-otp-box">
        <p className="pf-otp-label">Enter this OTP on the machine</p>

        {/* BIG HERO OTP */}
        <div className="pf-otp-code">{otp}</div>

        <p className="pf-otp-expiry">Keep this screen open until printing is complete</p>

        {qrToken ? (
          <>
            <div className="pf-or">or scan QR</div>
            <div className="pf-qr-wrap">
              <QRCodeCanvas
                value={qrToken}
                size={160}
                bgColor="#ffffff"
                fgColor="#0d0d0d"
                level="H"
              />
            </div>
            <p className="pf-qr-hint">
              Scan with the kiosk camera<br />
              or type the OTP on the keypad
            </p>
          </>
        ) : null}
      </div>

      <div className="pf-waiting">
        <span className="pf-spinner dark" />
        Waiting for print confirmation...
      </div>
    </div>
  );
}



// // steps/StepOTP.jsx
// import React from "react";
// import { QRCodeCanvas } from "qrcode.react";

// export default function StepOTP({ otp, qrToken, jobSuccess, jobError }) {
//   return (
//     <div className="pf-step-enter">
//       <p className="pf-section-title"><span>🔐</span> Collect Your Prints</p>

//       {jobSuccess && (
//         <div className="pf-alert success">✓ {jobSuccess}</div>
//       )}

//       {jobError && (
//         <div className="pf-alert error">⚠ {jobError}</div>
//       )}

//       <div className="pf-otp-box">
//         {/* OTP CODE */}
//         <p className="pf-otp-label">Enter this OTP on the machine</p>
//         <div className="pf-otp-code">{otp}</div>
//         <p className="pf-otp-expiry">Keep this screen open until printing is complete</p>

//         {/* QR CODE */}
//         {qrToken && (
//           <>
//             <div className="pf-or">OR scan QR</div>
//             <div className="pf-qr-wrap">
//               <QRCodeCanvas
//                 value={qrToken}
//                 size={180}
//                 bgColor="#ffffff"
//                 fgColor="#1a1916"
//                 level="H"
//               />
//             </div>
//             <p className="pf-qr-hint">
//               Scan the QR code with the kiosk camera<br />
//               or enter the OTP manually on the keypad
//             </p>
//           </>
//         )}
//       </div>

//       {/* Waiting indicator */}
//       <div className="pf-waiting">
//         <span className="pf-spinner dark" />
//         Waiting for print confirmation...
//       </div>
//     </div>
//   );
// }