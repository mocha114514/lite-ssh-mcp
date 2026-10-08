/**
 * First-run files are deliberately separate: only config.json is live.
 * The example uses reserved documentation addresses and placeholder secrets;
 * it must never be merged into the live server list automatically.
 */
export const EMPTY_CONFIG_TEXT = `${JSON.stringify({ version: 2, servers: {} }, null, 2)}\n`;

/** Two IPs × two ports × two accounts demonstrate every parallel map level. */
export const EXAMPLE_CONFIG_TEXT = `${JSON.stringify({
  version: 2,
  servers: {
    '192.0.2.10': {
      '22': {
        label: 'server-a-port-22',
        accounts: {
          alice: { auth: { type: 'password', password: '<服务器A、端口22、alice的密码>' } },
          bob: { auth: { type: 'password', password: '<服务器A、端口22、bob的密码>' } },
        },
      },
      '2222': {
        label: 'server-a-port-2222',
        accounts: {
          alice: { auth: { type: 'password', password: '<服务器A、端口2222、alice的密码>' } },
          deploy: { auth: { type: 'password', password: '<服务器A、端口2222、deploy的密码>' } },
        },
      },
    },
    '198.51.100.20': {
      '22': {
        label: 'server-b-port-22',
        accounts: {
          admin: { auth: { type: 'password', password: '<服务器B、端口22、admin的密码>' } },
          ops: { auth: { type: 'password', password: '<服务器B、端口22、ops的密码>' } },
        },
      },
      '2200': {
        label: 'server-b-port-2200',
        accounts: {
          deploy: { auth: { type: 'password', password: '<服务器B、端口2200、deploy的密码>' } },
          monitor: { auth: { type: 'password', password: '<服务器B、端口2200、monitor的密码>' } },
        },
      },
    },
  },
}, null, 2)}\n`;
