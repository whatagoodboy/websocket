var express = require("express");
const { WebSocket } = require("ws");
const syncRequest = require("sync-request");
const mqtt = require('mqtt');
var app = express();
require("express-ws")(app);
app.use(express.json());

// Save ws associated with each tag
let tags = {};
// Save last tag event time
let lastTags = {};
// Keep last values for each VIN because only changed datas are send since 08/2024
let lastValues = {};
// Reference tags for raw data
let tagsRaw = {};
// Reference valid tokens
let invalidTokens = {};

// MQTT 客户端配置
const mqttOptions = {
  keepalive: 60,
  reconnectPeriod: 5000,
  connectTimeout: 30 * 1000
};

// 连接到 MQTT broker
const client = mqtt.connect('mqtt://mosquitto:1883', mqttOptions);

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  client.subscribe('tesla/v/#', (err) => {
    if (err) {
      console.error('Error subscribing to MQTT topic:', err);
    } else {
      console.log('Subscribed to tesla/v/#');
    }
  });
});

client.on('error', (error) => {
  console.error('MQTT connection error:', error);
});

client.on('close', () => {
  console.log('MQTT connection closed');
});

client.on('reconnect', () => {
  console.log('Trying to reconnect to MQTT broker...');
});

client.on('message', (topic, message) => {
  try {
    const data = message.toString();
    let transformedMessage = transformMessage(data);
    if (transformedMessage) {
      broadcastMessage(transformedMessage);
    }
  } catch (error) {
    console.error('Error processing MQTT message:', error);
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/send", (req, res) => {
  if (req.query.msg && req.query.tag) {
    let message = JSON.parse(
      '{"msg_type":"data:update","tag":"' +
        req.query.tag +
        '","value":"' +
        Date.now() +
        "," +
        req.query.msg +
        '"}',
    );
    broadcastMessage(message);
  }
  if (req.query.offline && req.query.tag) {
    let message = JSON.parse(
      '{"msg_type": "data:error", "tag": "' +
        req.query.tag +
        '", "error_type": "vehicle_error", "value": "Vehicle is offline"}',
    );
    broadcastMessage(message);
  }
  if (req.query.disconnect && req.query.tag) {
    let message = JSON.parse(
      '{"msg_type": "data:error", "tag": "' +
        req.query.tag +
        '", "error_type": "vehicle_disconnected"}',
    );
    broadcastMessage(message);
  }
  if (req.query.kick && req.query.tag) {
    if (tags[req.query.tag]) {
      tags[req.query.tag].close();
    }
  }
  res.status(200).json({ status: "ok" });
});

app.ws("/streaming/", (ws /*, req*/) => {
  /** Say hello to TeslaMate */
  const interval_id = setInterval(function () {
    ws.send(
      JSON.stringify({
        msg_type: "control:hello",
        connection_timeout: 30000,
      }),
    );
  }, 10000);

  /** Subscribe to vehicle streaming data */
  ws.on("message", function incoming(message) {
    const js = JSON.parse(message);
    let msg = "control:hello";
    if (js.msg_type == "data:subscribe_oauth" || js.msg_type == "data:subscribe_all") {
      console.log("Subscribe from: %s", js.tag);
      tags[js.tag] = ws;
      let err = null;
      if (js.msg_type == "data:subscribe_all") {
        // check if we allowed him
        try {
          if (!js.token || js.token.trim() === "") {
            err = "Token is missing or empty";
            console.error("Error: Token is missing or empty");
          } else if (invalidTokens[js.tag + js.token]) {
            err = "Token invalid (already tried)";
            console.error("Error: Token is invalid (already tried)");
          } else {
            const response = syncRequest(
              "GET",
              `https://api.myteslamate.com/api/1/vehicles/${js.tag}?token=${js.token}`
            );
            if (response.statusCode != 200) {
              invalidTokens[js.tag  + js.token] = true;
              err = response.body.toString();
              console.error("Synchronous API call failed with status:", response.body.toString());
            }
          }
        } catch (error) {
          err = error;
          console.error("Error during synchronous API call:", error);
        }

        if (err) {
          ws.send(
            JSON.stringify({
              msg_type: "error",
              error_detail: err,
              connection_timeout: 30000,
            }),
          );
          ws.close();
        } else {
          tagsRaw[js.tag] = true;
          msg = "control:hello:" + js.tag;
        }
      }

      ws.send(
        JSON.stringify({
          msg_type: msg,
          connection_timeout: 30000,
        }),
      );
    }
  });

  /** Delete connection when closed */
  ws.once("close", function close() {
    console.log("Close connection");
    clearInterval(interval_id);
    let keys = Object.keys(tags);
    for (let i = 0; i < keys.length; i++) {
      if (this == tags[keys[i]]) {
        console.log("Close: " + keys[i]);
        delete tags[keys[i]];
        delete lastTags[keys[i]];
        delete tagsRaw[keys[i]];
      }
    }
  });
});

/**
 * Transform a message from Tesla Telemetry to a websocket streaming message
 * @param {*} data
 * @returns
 */
function transformMessage(data) {
  try {
    const jsonData = JSON.parse(data);
    
    // 检查数据格式是否符合预期
    if (!jsonData || !jsonData.vin) {
      console.error('Invalid message format:', data);
      return null;
    }

    if (jsonData.vin in tagsRaw) {
      return {tag: jsonData.vin, raw: jsonData};
    }

    let associativeArray = {};

    // 确保 data 字段存在且是数组
    if (!Array.isArray(jsonData.data)) {
      console.error('Invalid data format, expected array:', jsonData);
      return null;
    }

    // Extract data from JSON event
    jsonData.data.forEach((item) => {
      if (item.value.locationValue) {
        associativeArray["Latitude"] = item.value.locationValue.latitude;
        associativeArray["Longitude"] = item.value.locationValue.longitude;
      } else {

        if (item.value.shiftStateValue) {
          associativeArray[item.key] = item.value.shiftStateValue.replace("ShiftState", "");
        } else if (item.value.doubleValue) {
          associativeArray[item.key] = item.value.doubleValue;
        } else {
          associativeArray[item.key] = item.value.stringValue;
        }
      }
    });

    // Save given values in lastValues
    if (!lastValues[jsonData.vin]) {
      lastValues[jsonData.vin] = {};
    }
    lastValues[jsonData.vin] = {
      ...lastValues[jsonData.vin],
      ...associativeArray,
    };
    associativeArray = lastValues[jsonData.vin];

    /** Prepare message for TeslaMate */
    // @TODO: wait the real value from https://github.com/teslamotors/fleet-telemetry/issues/170#issuecomment-2141034274)
    // In the meantime just return 0
    let power = 0;
    //let isCharging = false;

    let chargingPower = parseInt(associativeArray["DCChargingPower"]);
    if (chargingPower > 0) {
      power = chargingPower;
      //isCharging = true;
    }
    chargingPower = parseInt(associativeArray["ACChargingPower"]);
    if (chargingPower > 0) {
      power = chargingPower;
      //isCharging = true;
    }

    let speed = isNaN(parseInt(associativeArray["VehicleSpeed"]))
      ? ""
      : parseInt(associativeArray["VehicleSpeed"]);

    //console.log(associativeArray);
    let r = {
      msg_type: "data:update",
      tag: jsonData.vin,
      value: [
        new Date(jsonData.createdAt).getTime(),
        speed, // speed
        associativeArray["Odometer"], // odometer
        Object.prototype.hasOwnProperty.call(associativeArray, "Soc")
          ? parseInt(associativeArray["Soc"])
          : "", // soc
        "", // elevation is computed next
        associativeArray["GpsHeading"] ?? "", // est_heading (TODO: is this the good field?)
        associativeArray["Latitude"], // est_lat
        associativeArray["Longitude"], // est_lng
        power, // power
        associativeArray["Gear"] ?? "", // shift_state
        associativeArray["RatedRange"], // range
        associativeArray["EstBatteryRange"], // est_range
        associativeArray["GpsHeading"] ?? "", // heading
      ].join(","),
    };

    lastTags[jsonData.vin] = new Date().getTime();

    if (associativeArray["Latitude"] && associativeArray["Longitude"] && associativeArray["Gear"] && associativeArray["Gear"] != "") {
      return r;
    } else {
      console.debug('Missing required data fields for VIN:', jsonData.vin);
      return null;
    }
  } catch (e) {
    console.error('Error transforming message:', e);
    return null;
  }
}

/**
 * Forward a message from Tesla Telemetry to the websocket streaming client(s)
 * @param {*} message
 */
function broadcastMessage(msg) {
  try {
    if (msg && msg.tag in tags && tags[msg.tag].readyState === WebSocket.OPEN) {
      //console.log("Send to client " + msg.tag);
      if ('raw' in msg) {
        tags[msg.tag].send(JSON.stringify(msg.raw));
      } else {
       console.log(JSON.stringify(msg));
        tags[msg.tag].send(JSON.stringify(msg));
      }
    }
  } catch (e) {
    console.error(e);
  }
}

app.listen(8081, () => console.log("listening on http://localhost:8081/"));
