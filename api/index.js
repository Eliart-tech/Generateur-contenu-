// Fonction Vercel unique : vercel.json réécrit toutes les routes /api/* vers elle.
import { handleApi } from "../lib/app.mjs";

// Plan Hobby : 300 s maximum par requête.
export const config = { maxDuration: 300 };

export default function handler(req, res) {
  return handleApi(req, res);
}
