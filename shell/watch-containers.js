require('dotenv').config();
const Docker = require('dockerode');
const axios = require('axios');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Load environment variables
const CF_API_URL = process.env.CF_API__URL_HTTPS;
const CF_ACCOUNT_ID = process.env.CF_DNS__ACCOUNTS__SCOPED_ID;
const CF_ZONE_ID = process.env.CF_DNS__ACCOUNTS__SCOPED_ZONE;
const CF_DOMAIN = process.env.CF_DNS__DOMAINS_0__NAME;
const CF_TUNNEL_ID = process.env.CF_DNS__ACCOUNTS__SCOPED_TUNNEL;
const CF_TUNNEL_SUB_ID = process.env.CF_DNS__ACCOUNTS__SUB_TUNNEL;
const CF_API_TOKEN = process.env.CF_DNS__AUTH__SCOPED_TOKEN;
const CF_INGRESS_SERVICE = process.env.CF_DNS__INGRESS_SERVICE;
const CF_TLS_VERIFY = process.env.CF_DNS__NO_TLS__VERIFY === 'true';
const CF_PROXY = process.env.CF_DNS__DOMAINS_0__PROXIED === 'true';

function ensureFallbackIsLast(ingress, fallbackService) {
  const fallbackEntries = ingress.filter(entry => !entry.hostname);
  let filtered = ingress.filter(entry => entry.hostname);

  if (fallbackEntries.length === 0) {
    filtered.push({ service: fallbackService });
    console.log("Added fallback ingress entry.");
  } else {
    filtered.push(fallbackEntries[0]);
    if (fallbackEntries.length > 1) {
      console.warn("Multiple fallback entries found, using the first one only.");
    }
  }

  return filtered;
}

// Watch Docker Events
docker.getEvents({
  filters: {
    type: ['container'],
    event: ['create', 'destroy']
  }
}, (err, stream) => {
  if (err) throw err;

  stream.on('data', async (chunk) => {
    const event = JSON.parse(chunk.toString());
    const eventType = event.Action;
    const containerId = event.id;

    console.log("Event:", event);
    console.log("-");
    console.log(`Event type=${eventType}`);
    console.log(`Container id=${containerId}`);
    console.log(`Domain=${CF_DOMAIN}`);

    try {
      const labels = event.Actor?.Attributes || {};
      let domain = '';
      const ruleLabel = Object.entries(labels).find(([key]) =>
        key.includes('traefik.http.routers') && key.endsWith('.rule')
      );

      if (ruleLabel && ruleLabel[1]) {
        const match = ruleLabel[1].match(/Host\(`([^`]*)`\)/);
        if (match && match[1].includes(CF_DOMAIN)) {
          domain = match[1];
        }
      }

      if (!domain) {
        console.log("No domain found, skipping...");
        return;
      }

      console.log("Detected domain:", domain);

      const cfUrl = `${CF_API_URL}/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations`;
      const headers = {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json'
      };

      const queryRes = await axios.get(cfUrl, { headers });
      
      const config = queryRes.data?.result?.config;
      if (!config) {
        console.error('Cloudflare response missing `result.config`');
        return;
      }

      const oldIngress = config.ingress || [];
      let ingress = JSON.parse(JSON.stringify(oldIngress));
      const warpRouting = config["warp-routing"] || {};

      console.log("queryRes.data.ingress:", JSON.stringify(ingress, null, 2));
      console.log("queryRes.data.warpRouting:", JSON.stringify(warpRouting, null, 2));

      const exists = ingress.some(entry => entry.hostname === domain);
      if (eventType === 'create' && !exists) {
        ingress.push({
          service: CF_INGRESS_SERVICE,
          hostname: domain,
          originRequest: {
            noTLSVerify: CF_TLS_VERIFY
          }
        });
        console.log(`Added hostname: ${domain}`);
      } else if (eventType === 'destroy' && exists) {
        ingress = ingress.filter(entry => entry.hostname !== domain);
        console.log(`Removed hostname: ${domain}`);
      } else {
        console.log(`No change needed for ${domain}`);
      }

      const isChanged = JSON.stringify(ingress) !== JSON.stringify(oldIngress);
      if (isChanged) {
        ingress = ensureFallbackIsLast(ingress, CF_INGRESS_SERVICE);

        console.log("ensureFallbackIsLast.ingress:", JSON.stringify(ingress, null, 2));
        
        await axios.put(cfUrl, {
          config: {
            ingress,
            "warp-routing": warpRouting
          }
        }, { headers });
        console.log(`Ingress updated for ${domain}`);
      } else {
        console.log(`Ingress unchanged for ${domain}, skipping patch.`);
      }

      // DNS Handling
      if (eventType === 'create' && !exists) {
        try {
          const response = await axios.post(
            `${CF_API_URL}/zones/${CF_ZONE_ID}/dns_records`,
            {
              type: 'CNAME',
              name: domain,
              content: `${CF_TUNNEL_ID}.${CF_TUNNEL_SUB_ID}`,
              proxied: CF_PROXY
            },
            { headers }
          );
          console.log('Created DNS record:', response.data);
        } catch (error) {
          console.error('Failed to create DNS record:', error.response?.data || error.message || error);
        }
      } else if (eventType === 'destroy' && exists) {
        try {
          const queryResponse = await axios.get(
            `${CF_API_URL}/zones/${CF_ZONE_ID}/dns_records`,
            {
              headers,
              params: {
                type: 'CNAME',
                name: domain
              }
            }
          );
          const results = queryResponse.data.result;
          const record = results.find(r => r.name === domain);
          
          if (record && record.id) {
            const deleteResponse = await axios.delete(
              `${CF_API_URL}/zones/${CF_ZONE_ID}/dns_records/${record.id}`,
              { headers }
            );
            console.log(`Deleted DNS record for ${domain}:`, deleteResponse.data);
          } else {
            console.log(`No matching DNS record to delete for ${domain}`);
          }
        } catch (error) {
          console.error('Failed to delete DNS record:', error.response?.data || error.message || error);
        }
      }
    } catch (error) {
      if (error.response) {
        console.error('Cloudflare API Error:', {
          status: error.response.status,
          data: error.response.data
        });
      } else {
        console.error('Unexpected Error:', error.message || error);
      }
    }
    console.log('---');
  });
});
