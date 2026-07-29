// Simple return page Flutterwave redirects to after checkout. The Flutter
// WebView intercepts this URL to know the flow is done, then verifies via
// GET /api/payments/:id. This HTML is only shown if opened in a browser.
export const dynamic = 'force-dynamic';
export default function PaymentComplete({ searchParams }) {
  const status = searchParams?.status || 'completed';
  return (
    <html><body style={{fontFamily:'system-ui',display:'grid',placeItems:'center',height:'100vh',margin:0,background:'#F6F8FB'}}>
      <div style={{textAlign:'center',padding:24}}>
        <div style={{fontSize:48}}>{status === 'successful' ? '✅' : '↩️'}</div>
        <h2 style={{color:'#08295D',margin:'12px 0'}}>Payment {status}</h2>
        <p style={{color:'#64748b'}}>You can return to the Peleka app now.</p>
      </div>
    </body></html>
  );
}
