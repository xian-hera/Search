// ─── Apple Wallet Pass generation ────────────────────────────────────────────
// Add this section to server.js before app.listen()

import { PKPass } from "passkit-generator";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const wwdr        = readFileSync(join(__dirname, "certs/wwdr.pem"));
const signerCert  = readFileSync(join(__dirname, "certs/signerCert.pem"));
const signerKey   = readFileSync(join(__dirname, "certs/signerKey.pem"));

const QR_SECRET_PASS = process.env.QR_SECRET;

function buildQrToken(customerId) {
  const payload = {
    customer_id: customerId,
    shop: process.env.SHOP_DOMAIN,
    issued_at: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const hmac = crypto
    .createHmac("sha256", QR_SECRET_PASS)
    .update(payloadB64)
    .digest("hex");
  return `${payloadB64}.${hmac}`;
}

const PASS_CUSTOMER_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      loyaltyPoints: metafield(namespace: "loyalty", key: "points") {
        value
      }
    }
  }
`;

app.get("/api/pass/generate/:customerId", async (req, res) => {
  const { customerId } = req.params;
  if (!customerId) return res.status(400).json({ error: "Missing customerId" });

  try {
    // Fetch customer from Shopify
    const gid = `gid://shopify/Customer/${customerId}`;
    const data = await shopifyGraphQL(PASS_CUSTOMER_QUERY, { id: gid });
    const customer = data.customer;
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const points = customer.loyaltyPoints?.value ?? "0";
    const qrToken = buildQrToken(customerId);

    const pass = await PKPass.from({
      model: join(__dirname, "passkit/loyalty.pass"),
      certificates: { wwdr, signerCert, signerKey },
    }, {
      serialNumber: `hera-${customerId}`,
    });

    pass.setBarcodes({
      message: qrToken,
      format: "PKBarcodeFormatQR",
      messageEncoding: "iso-8859-1",
    });

    pass.setPassStructureDictionary("storeCard", {
      primaryFields: [
        { key: "points", label: "Points", value: points }
      ],
      secondaryFields: [
        { key: "name", label: "Member", value: `${customer.firstName} ${customer.lastName}` }
      ],
    });

    const buffer = pass.getAsBuffer();

    res.set({
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition": `attachment; filename="hera-loyalty.pkpass"`,
      "Content-Length": buffer.length,
    });
    res.send(buffer);

  } catch (err) {
    console.error("Pass generation failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});
