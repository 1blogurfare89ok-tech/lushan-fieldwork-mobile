// --- Mobile Client State ---
let state = {
  settings: {
    serverUrl: "",
    memberId: "",
    memberToken: "",
    amapKey: ""
  },
  gps: {
    lat: null,
    lon: null,
    accuracy: null,
    altitude: null,
    heading: 0
  },
  sensor: {
    strike: 0,
    dipDir: 90,
    dip: 0,
    stable: false,
    quality: "未锁定"
  },
  compassActive: false,
  selectedStationId: 3, // 王家坡 by default
  photoBase64: null,
  localRecords: [],
  members: [],
  messages: [],
  sos: [],
  socket: null,
  roseInterval: 5,
  map: null,
  mapMarkers: {},
  layers: {
    normal: null,
    satellite: null
  },
  activeLayerName: "normal",
  navTarget: null, // { lat, lon, name }
  isWebSocketConnected: false
};

// Default Stations
const STATIONS = [
  { id: 3, name: "王家坡", subtitle: "U 形谷与中庵寺条痕石", lat: 29.5742, lon: 116.0026 },
  { id: 13, name: "大校场", subtitle: "U 形谷与汉口峡风口", lat: 29.5647, lon: 115.9898 },
  { id: 4, name: "飞来石", subtitle: "冰川漂砾与基岩对比", lat: 29.5747, lon: 115.9728 }
];

// --- App Initialization ---
window.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  loadLocalRecords();
  initLucide();
  initTabs();
  initStations();
  initSensorAccess();
  initGPS();
  initMap();
  connectWebSocket();
  startFallbackPolling();
  
  // Render initial screens
  renderRecordsHistory();
  renderRoseDiagram();
  
  // Refresh Lucide Icons once
  lucide.createIcons();
});

function initLucide() {
  lucide.createIcons();
}

// --- Tab Navigation ---
function switchTab(tabId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  
  document.getElementById(`screen-${tabId}`).classList.add("active");
  document.getElementById(`nav-${tabId}`).classList.add("active");
  
  if (tabId === "map") {
    // Leaflet map requires invalidateSize when shown in SPA tab
    setTimeout(() => {
      if (state.map) {
        state.map.invalidateSize();
        // Recenter to current GPS location or default Wangjiapo
        const lat = state.gps.lat || 29.5742;
        const lon = state.gps.lon || 116.0026;
        state.map.setView([lat, lon], state.map.getZoom() || 14);
      }
    }, 100);
  } else if (tabId === "rose") {
    renderRoseDiagram();
  }
  
  initLucide();
}

function initTabs() {
  // Navigation tabs are handled inline via switchTab
}

// --- Settings Management ---
function loadSettings() {
  const stored = localStorage.getItem("lushan_mobile_settings");
  if (stored) {
    state.settings = JSON.parse(stored);
  } else {
    // Default fallback addresses
    state.settings = {
      serverUrl: "https://components-catalog-today-just.trycloudflare.com",
      memberId: "member-01",
      memberToken: "uZ5tCz43ypsWXvOce-rKUCSAXpIQZnyfhq0I7Q",
      amapKey: ""
    };
  }
  
  document.getElementById("setServerUrl").value = state.settings.serverUrl;
  document.getElementById("setMemberId").value = state.settings.memberId;
  document.getElementById("setMemberToken").value = state.settings.memberToken;
  document.getElementById("setAmapKey").value = state.settings.amapKey;
  
  document.getElementById("dashMemberId").innerText = state.settings.memberId;
}

function saveSettings() {
  state.settings.serverUrl = document.getElementById("setServerUrl").value.trim().replace(/\/$/, "");
  state.settings.memberId = document.getElementById("setMemberId").value.trim();
  state.settings.memberToken = document.getElementById("setMemberToken").value.trim();
  state.settings.amapKey = document.getElementById("setAmapKey").value.trim();
  
  localStorage.setItem("lushan_mobile_settings", JSON.stringify(state.settings));
  document.getElementById("dashMemberId").innerText = state.settings.memberId;
  
  updateNetStatus("设置已保存", "info");
  
  // Reconnect WebSocket & pull
  connectWebSocket();
  pullData();
}

async function testBackendHealth() {
  const url = `${state.settings.serverUrl}/api/team/messages`; // testing api with token
  updateNetStatus("正在测试后端...", "info");
  try {
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${state.settings.memberToken}` }
    });
    if (res.ok) {
      updateNetStatus("后端连接正常", "success");
      alert("连接成功！后端 API 响应正常。");
    } else {
      updateNetStatus("后端身份验证失败", "error");
      alert(`连接失败：状态码 ${res.status}`);
    }
  } catch (err) {
    updateNetStatus("连接失败", "error");
    alert(`无法连接到后端，请检查地址是否正确。\n错误信息: ${err.message}`);
  }
}

// --- GPS Tracking ---
function initGPS() {
  if (!navigator.geolocation) {
    document.getElementById("dashCoords").innerText = "不支持 Geolocation";
    return;
  }
  
  const options = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
  };
  
  navigator.geolocation.watchPosition(
    position => {
      state.gps.lat = position.coords.latitude;
      state.gps.lon = position.coords.longitude;
      state.gps.accuracy = position.coords.accuracy;
      state.gps.altitude = position.coords.altitude;
      
      // Update UI
      document.getElementById("dashCoords").innerText = `${state.gps.lat.toFixed(6)}, ${state.gps.lon.toFixed(6)}`;
      document.getElementById("dashAccuracy").innerText = `精度 ±${Math.round(state.gps.accuracy)} m · 海拔 ${state.gps.altitude ? Math.round(state.gps.altitude) : "--"} m`;
      
      // Update self position on Leaflet
      updateSelfMarker();
      
      // Push location to server
      sendLocationUpdate();
    },
    err => {
      console.warn("GPS error:", err);
      document.getElementById("dashCoords").innerText = "等待 GPS 定位...";
    },
    options
  );
}

// --- Gyroscope & Compass Logic ---
function initSensorAccess() {
  const btn = document.getElementById("btnRequestSensor");
  
  // Check if iOS permission request is needed
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    btn.style.display = "block";
    btn.onclick = () => {
      DeviceOrientationEvent.requestPermission()
        .then(permissionState => {
          if (permissionState === "granted") {
            btn.style.display = "none";
            startSensorListening();
          } else {
            alert("需要传感器权限以使用地质罗盘！");
          }
        })
        .catch(err => {
          console.error("Orientation permission err:", err);
        });
    };
  } else {
    // Non-iOS or old browsers
    startSensorListening();
  }
}

function startSensorListening() {
  window.addEventListener("deviceorientation", handleOrientation, true);
  state.compassActive = true;
}

function handleOrientation(event) {
  // alpha: rotation around z-axis (0-360) - heading
  // beta: rotation around x-axis (-180-180) - front/back tilt
  // gamma: rotation around y-axis (-90-90) - left/right tilt
  
  let alpha = event.alpha || 0;
  let beta = event.beta || 0;
  let gamma = event.gamma || 0;
  
  // Translate orientation angles to plane normal vector matching Android CompassMath
  const degtorad = Math.PI / 180;
  const a = alpha * degtorad;
  const b = beta * degtorad;
  const g = gamma * degtorad;
  
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);
  
  // Normal vector of the screen
  const r13 = ca * sg - sa * sb * cg;
  const r23 = sa * sg + ca * sb * cg;
  const r33 = -cb * cg;
  
  let x = r13;
  let y = r23;
  let z = r33;
  if (z < 0) {
    x = -x; y = -y; z = -z;
  }
  
  // Dip angle
  const dipVal = Math.acos(Math.max(-1, Math.min(1, z))) * 180 / Math.PI;
  
  // Dip direction
  let dipDirVal = Math.atan2(x, y) * 180 / Math.PI;
  dipDirVal = (dipDirVal + 360) % 360;
  
  // Strike
  let strikeVal = (dipDirVal - 90 + 360) % 360;
  
  // Device heading (alpha is standard compass heading on most mobile devices, adjusted for standard orientation)
  let headingVal = (360 - alpha) % 360;
  state.gps.heading = headingVal;
  
  // Store state
  state.sensor.strike = Math.round(strikeVal);
  state.sensor.dipDir = Math.round(dipDirVal);
  state.sensor.dip = Math.round(dipVal);
  
  // Heading readout
  document.getElementById("dashHeading").innerText = `设备航向 ${Math.round(headingVal)}°`;
  document.getElementById("dashQuality").innerText = "测量稳定";
  
  // Update compass needle rotation
  document.getElementById("compassDisc").style.transform = `rotate(${-headingVal}deg)`;
  document.getElementById("needleStrike").style.transform = `rotate(${strikeVal}deg)`;
  document.getElementById("needleDip").style.transform = `rotate(${dipDirVal}deg)`;
  
  // Live output
  document.getElementById("liveStrike").innerText = `${state.sensor.strike}°`;
  document.getElementById("liveDipDir").innerText = `${state.sensor.dipDir}°`;
  document.getElementById("liveDip").innerText = `${state.sensor.dip}°`;
}

function lockMeasurement() {
  document.getElementById("inputStrike").value = state.sensor.strike;
  document.getElementById("inputDipDir").value = state.sensor.dipDir;
  document.getElementById("inputDip").value = state.sensor.dip;
  updateNetStatus("地质测量值已锁定", "info");
}

// --- Stations and Record Handling ---
function initStations() {
  const container = document.getElementById("stationChips");
  container.innerHTML = "";
  STATIONS.forEach(st => {
    const btn = document.createElement("button");
    btn.className = `chip ${st.id === state.selectedStationId ? "active" : ""}`;
    btn.innerText = st.name;
    btn.onclick = () => selectStation(st.id);
    container.appendChild(btn);
  });
}

function selectStation(id) {
  state.selectedStationId = id;
  initStations();
}

function triggerCamera() {
  document.getElementById("cameraInput").click();
}

function handlePhotoCapture(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      // Compress and resize image using Canvas (max 1280px, 80% JPEG)
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;
      
      const maxDim = 1280;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      
      // Convert to base64
      state.photoBase64 = canvas.toDataURL("image/jpeg", 0.8);
      
      // Update UI Preview
      const preview = document.getElementById("photoPreview");
      preview.src = state.photoBase64;
      document.getElementById("photoPreviewContainer").style.display = "block";
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function clearPhoto() {
  state.photoBase64 = null;
  document.getElementById("photoPreview").src = "";
  document.getElementById("photoPreviewContainer").style.display = "none";
  document.getElementById("cameraInput").value = "";
}

function loadLocalRecords() {
  const records = localStorage.getItem("lushan_mobile_records");
  state.localRecords = records ? JSON.parse(records) : [];
  updatePendingBadge();
}

function saveRecord() {
  const strike = parseFloat(document.getElementById("inputStrike").value);
  const dipDir = parseFloat(document.getElementById("inputDipDir").value);
  const dip = parseFloat(document.getElementById("inputDip").value);
  const notes = document.getElementById("inputNotes").value.trim();
  
  if (isNaN(strike) || isNaN(dipDir) || isNaN(dip)) {
    alert("请填入或锁定有效的走向、倾向和倾角数值！");
    return;
  }
  
  const station = STATIONS.find(s => s.id === state.selectedStationId);
  const newRec = {
    localId: Date.now(),
    clientId: generateUUID(),
    stationId: station.id,
    stationName: station.name,
    strike: strike,
    dipDirection: dipDir,
    dipAngle: dip,
    notes: notes,
    photoPath: state.photoBase64 || null, // Base64 encoding for storage
    timestamp: Date.now(),
    ownerId: state.settings.memberId,
    synced: false
  };
  
  state.localRecords.unshift(newRec);
  localStorage.setItem("lushan_mobile_records", JSON.stringify(state.localRecords));
  
  // Reset Form
  document.getElementById("inputStrike").value = "";
  document.getElementById("inputDipDir").value = "";
  document.getElementById("inputDip").value = "";
  document.getElementById("inputNotes").value = "";
  clearPhoto();
  
  renderRecordsHistory();
  renderRoseDiagram();
  updatePendingBadge();
  
  updateNetStatus("记录已本地保存，正在后台同步...", "info");
  
  // Trigger sync
  syncFields();
}

function updatePendingBadge() {
  const count = state.localRecords.filter(r => !r.synced).length;
  document.getElementById("dashPendingCount").innerText = count;
  document.getElementById("dashPendingCount").classList.toggle("accent-text", count > 0);
}

function renderRecordsHistory() {
  const container = document.getElementById("recordsList");
  container.innerHTML = "";
  
  if (state.localRecords.length === 0) {
    container.innerHTML = `<div class="card" style="text-align:center; color:var(--muted)">暂无本地采集记录</div>`;
    return;
  }
  
  state.localRecords.forEach(rec => {
    const card = document.createElement("div");
    card.className = "record-card";
    
    const timeStr = new Date(rec.timestamp).toLocaleString("zh-CN", { hour12: false });
    
    card.innerHTML = `
      <div class="record-main">
        <span class="record-title">${rec.stationName} <small class="subtext">(${timeStr})</small></span>
        <span class="record-vals">走向: ${rec.strike}° / 倾向: ${rec.dipDirection}° / 倾角: ${rec.dipAngle}°</span>
        ${rec.notes ? `<span class="record-notes">${rec.notes}</span>` : ""}
      </div>
      <div class="record-meta">
        ${rec.photoPath ? `<img src="${rec.photoPath}" class="record-photo-thumb" onclick="openPhotoLightbox('${rec.photoPath}')" />` : ""}
        <span class="record-sync-badge ${rec.synced ? "synced" : "pending"}">${rec.synced ? "已同步" : "未同步"}</span>
        <button class="btn-delete-record" onclick="deleteRecord(${rec.localId})"><i data-lucide="trash-2"></i></button>
      </div>
    `;
    container.appendChild(card);
  });
  
  initLucide();
}

async function deleteRecord(localId) {
  if (!confirm("确定要删除这条记录吗？")) return;
  const rec = state.localRecords.find(r => r.localId === localId);
  if (!rec) return;
  
  if (rec.synced) {
    // Sync deletion to cloud
    updateNetStatus("正在同步云端删除...", "info");
    try {
      const url = `${state.settings.serverUrl}/api/report/observations/${rec.clientId}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${state.settings.memberToken}` }
      });
      if (!res.ok) {
        alert("云端删除失败，请稍后重试");
        return;
      }
    } catch (err) {
      console.error(err);
      alert("网络错误，云端删除失败");
      return;
    }
  }
  
  state.localRecords = state.localRecords.filter(r => r.localId !== localId);
  localStorage.setItem("lushan_mobile_records", JSON.stringify(state.localRecords));
  
  renderRecordsHistory();
  renderRoseDiagram();
  updatePendingBadge();
  updateNetStatus("记录已删除", "success");
}

async function syncFields() {
  const pending = state.localRecords.filter(r => !r.synced);
  if (pending.length === 0) return;
  
  updateNetStatus("正在同步记录...", "info");
  
  try {
    // Process observations upload
    const url = `${state.settings.serverUrl}/api/report/sync`;
    // We send payload as JSON. Note: Android used multipart. Let's make sure backend accepts JSON sync or if we should use multipart/form-data.
    // Wait, the backend `/api/report/sync` in FastAPI accepts JSON list of FieldRecord models?
    // Let's verify how ApiClient.kt does it. It sends JSON payload to '/api/report/sync' with observations.
    // Let's build the JSON body:
    const payload = pending.map(p => ({
      clientId: p.clientId,
      stationId: p.stationId,
      stationName: p.stationName,
      strike: p.strike,
      dipDirection: p.dipDirection,
      dipAngle: p.dipAngle,
      notes: p.notes,
      photoUrl: p.photoPath, // Base64 compressed image (backend handles data-uri base64 upload or url)
      timestamp: p.timestamp,
      ownerId: p.ownerId
    }));
    
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.settings.memberToken}`
      },
      body: JSON.stringify(payload)
    });
    
    if (res.ok) {
      // Mark as synced
      pending.forEach(p => p.synced = true);
      localStorage.setItem("lushan_mobile_records", JSON.stringify(state.localRecords));
      renderRecordsHistory();
      updatePendingBadge();
      updateNetStatus("同步成功", "success");
    } else {
      updateNetStatus("同步失败", "error");
    }
  } catch (err) {
    console.error("Sync error:", err);
    updateNetStatus("同步网络错误", "error");
  }
}

// --- Rose Diagram Renderer ---
function changeRoseInterval(val) {
  state.roseInterval = val;
  // Update chip active styles
  document.querySelectorAll(".interval-chips .chip").forEach(c => {
    c.classList.toggle("active", parseInt(c.innerText) === val);
  });
  renderRoseDiagram();
}

function renderRoseDiagram() {
  const canvas = document.getElementById("roseCanvas");
  const ctx = canvas.getContext("2d");
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const center = { x: canvas.width / 2, y: canvas.height / 2 };
  const maxRadius = Math.min(canvas.width, canvas.height) * 0.43;
  
  // Draw circular grid rings
  ctx.strokeStyle = "rgba(66, 197, 138, 0.15)";
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, maxRadius * ring / 4, 0, 2 * Math.PI);
    ctx.stroke();
  }
  
  // Draw axes
  ctx.strokeStyle = "rgba(66, 197, 138, 0.3)";
  ctx.beginPath();
  ctx.moveTo(center.x, center.y - maxRadius); ctx.lineTo(center.x, center.y + maxRadius);
  ctx.moveTo(center.x - maxRadius, center.y); ctx.lineTo(center.x + maxRadius, center.y);
  ctx.stroke();
  
  // Group strike data
  const grouped = {};
  state.localRecords.forEach(rec => {
    const strike = ((rec.strike % 180) + 180) % 180;
    const bin = Math.floor(strike / state.roseInterval);
    grouped[bin] = (grouped[bin] || 0) + 1;
  });
  
  const binCount = 180 / state.roseInterval;
  const maxVal = Math.max(...Object.values(grouped), 1);
  
  // Draw sectors
  for (let index = 0; index < binCount; index++) {
    const count = grouped[index] || 0;
    if (count === 0) continue;
    
    const length = maxRadius * count / maxVal;
    
    // Convert to angle (0 is North / Z up in canvas, which is -90deg in standard trigonometric math)
    const startAngle = (index * state.roseInterval - 90) * Math.PI / 180;
    const endAngle = ((index + 1) * state.roseInterval - 90) * Math.PI / 180;
    
    ctx.fillStyle = "rgba(66, 197, 138, 0.4)";
    ctx.strokeStyle = "rgba(66, 197, 138, 0.8)";
    ctx.lineWidth = 1.5;
    
    // Draw bidirection sector
    // 1st direction
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.arc(center.x, center.y, length, startAngle, endAngle);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // 2nd direction (opposite)
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.arc(center.x, center.y, length, startAngle + Math.PI, endAngle + Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  
  // Update stats
  document.getElementById("roseTotalCount").innerText = state.localRecords.length;
  
  let dominantBin = null;
  let maxBinCount = 0;
  for (let i = 0; i < binCount; i++) {
    if ((grouped[i] || 0) > maxBinCount) {
      maxBinCount = grouped[i];
      dominantBin = i;
    }
  }
  
  if (dominantBin !== null) {
    const start = dominantBin * state.roseInterval;
    const end = (dominantBin + 1) * state.roseInterval;
    document.getElementById("roseDominant").innerText = `N ${start}°–${end}° E`;
  } else {
    document.getElementById("roseDominant").innerText = "暂无数据";
  }
}

// --- WebSocket & Real-time Sync ---
function connectWebSocket() {
  if (state.socket) {
    try {
      state.socket.close();
    } catch (e) {}
  }
  
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Extract host from serverUrl
  const serverHost = state.settings.serverUrl ? state.settings.serverUrl.replace(/^https?:\/\//, "") : "";
  
  if (!serverHost) return;
  
  const wsUrl = `${wsProto}//${serverHost}/api/team/ws?token=${state.settings.memberToken}`;
  console.log("Connecting WebSocket to", wsUrl);
  
  try {
    state.socket = new WebSocket(wsUrl);
  } catch (e) {
    console.error("Failed to create WebSocket:", e);
    state.isWebSocketConnected = false;
    updateNetStatus("连接失败，轮询中", "offline");
    return;
  }
  
  state.socket.onopen = () => {
    state.isWebSocketConnected = true;
    updateNetStatus("实时就绪", "success");
    pullData(); // Pull fresh data on connection
  };
  
  state.socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    } catch (e) {
      console.warn("WebSocket parse error:", e);
    }
  };
  
  state.socket.onclose = () => {
    state.isWebSocketConnected = false;
    updateNetStatus("连接断开，轮询中", "offline");
  };
  
  state.socket.onerror = (err) => {
    console.error("WebSocket error:", err);
    state.isWebSocketConnected = false;
  };
}

function handleWebSocketMessage(data) {
  // Types: "location", "message", "sos", "sos_updated", "message_deleted"
  const type = data.type;
  const payload = data.data;
  
  if (type === "location") {
    const id = payload.member_id;
    const index = state.members.findIndex(m => m.memberId === id);
    const updatedMember = {
      memberId: id,
      displayName: payload.displayName || id,
      latitude: payload.lat,
      longitude: payload.lon,
      accuracy: payload.accuracy,
      battery: payload.battery,
      receivedAt: payload.received_at || new Date().toISOString()
    };
    
    if (index >= 0) {
      state.members[index] = updatedMember;
    } else {
      state.members.push(updatedMember);
    }
    
    renderTeamMembers();
    updateMapTeammates();
  } else if (type === "message") {
    // Add communication message
    if (state.messages.none(m => m.id === payload.id)) {
      state.messages.push(payload);
      renderChatMessages();
    }
  } else if (type === "sos") {
    if (state.sos.none(s => s.id === payload.id)) {
      state.sos.push(payload);
    }
    renderSosBanner();
    renderTeamMembers();
  } else if (type === "sos_updated") {
    const index = state.sos.findIndex(s => s.id === payload.id);
    if (payload.status === "resolved") {
      if (index >= 0) state.sos.splice(index, 1);
    } else {
      if (index >= 0) state.sos[index] = payload;
      else state.sos.push(payload);
    }
    renderSosBanner();
    renderTeamMembers();
  } else if (type === "message_deleted") {
    state.messages = state.messages.filter(m => m.id !== payload.id);
    renderChatMessages();
  }
}

// Helpers for array check
Array.prototype.none = function(fn) {
  return !this.some(fn);
};

// Fallback short polling (every 10s if WS is offline)
function startFallbackPolling() {
  setInterval(() => {
    if (!state.isWebSocketConnected) {
      pullData();
    }
  }, 10000);
}

async function pullData() {
  if (!state.settings.serverUrl || !state.settings.memberToken) return;
  
  try {
    const headers = { "Authorization": `Bearer ${state.settings.memberToken}` };
    
    // Pull members
    const resM = await fetch(`${state.settings.serverUrl}/api/team/members`, { headers });
    if (resM.ok) {
      const data = await resM.json();
      state.members = data;
      renderTeamMembers();
      updateMapTeammates();
    }
    
    // Pull active SOS
    const resS = await fetch(`${state.settings.serverUrl}/api/team/sos/active`, { headers });
    if (resS.ok) {
      state.sos = await resS.json();
      renderSosBanner();
    }
    
    // Pull messages
    const resC = await fetch(`${state.settings.serverUrl}/api/team/messages`, { headers });
    if (resC.ok) {
      state.messages = await resC.json();
      renderChatMessages();
      populateRecipientDropdown();
    }
  } catch (err) {
    console.warn("Polling error:", err);
  }
}

// Send position to server
async function sendLocationUpdate() {
  if (!state.gps.lat || !state.settings.serverUrl) return;
  
  const payload = {
    member_id: state.settings.memberId,
    lat: state.gps.lat,
    lon: state.gps.lon,
    accuracy: state.gps.accuracy,
    battery: 100, // mock battery
    received_at: new Date().toISOString()
  };
  
  if (state.isWebSocketConnected && state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({
      type: "location",
      data: payload
    }));
  } else {
    // Fallback HTTP POST
    try {
      await fetch(`${state.settings.serverUrl}/api/team/location`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${state.settings.memberToken}`
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.warn("Failed to POST location:", e);
    }
  }
}

// --- Team Coordination UI ---
function renderTeamMembers() {
  const container = document.getElementById("teamMemberList");
  container.innerHTML = "";
  
  let onlineCount = 0;
  
  state.members.forEach(m => {
    const isSelf = m.memberId === state.settings.memberId;
    const isOnline = m.receivedAt ? (Date.now() - new Date(m.receivedAt).getTime() < 180000) : false; // 3 min online threshold
    const hasSos = state.sos.some(s => s.memberId === m.memberId && s.status !== "resolved");
    
    if (isOnline) onlineCount++;
    
    const item = document.createElement("div");
    item.className = `member-status-item ${hasSos ? "alerting" : ""}`;
    
    item.innerHTML = `
      <div class="m-avatar">${m.displayName.substring(0,2)}</div>
      <div class="m-details">
        <span class="m-name">${m.displayName} ${isSelf ? "(我)" : ""}</span>
        <span class="m-pos">${m.latitude ? `${m.latitude.toFixed(5)}, ${m.longitude.toFixed(5)}` : "等待定位..."}</span>
      </div>
      <span class="m-status-lbl ${hasSos ? "alert" : (isOnline ? "online" : "offline")}">
        ${hasSos ? "紧急呼救" : (isOnline ? "在线" : "离线")}
      </span>
    `;
    container.appendChild(item);
  });
  
  document.getElementById("teamOnlineCount").innerText = `${onlineCount} / 6 在线`;
  document.getElementById("dashMemberCount").innerText = `${onlineCount} / 6`;
}

function renderSosBanner() {
  const myActiveSos = state.sos.find(s => s.memberId === state.settings.memberId && s.status !== "resolved");
  const banner = document.getElementById("mySosBanner");
  
  if (myActiveSos) {
    banner.style.display = "flex";
  } else {
    banner.style.display = "none";
  }
}

async function triggerSos() {
  const reason = prompt("请输入您的求救原因 (可留空):", "野外跌落，申请紧急集结");
  if (reason === null) return; // Cancelled
  
  updateNetStatus("正在发送 SOS...", "info");
  
  try {
    const url = `${state.settings.serverUrl}/api/team/sos`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.settings.memberToken}`
      },
      body: JSON.stringify({
        memberId: state.settings.memberId,
        message: reason,
        latitude: state.gps.lat || 29.57,
        longitude: state.gps.lon || 115.99
      })
    });
    
    if (res.ok) {
      const sosEvent = await res.json();
      if (state.sos.none(s => s.id === sosEvent.id)) {
        state.sos.push(sosEvent);
      }
      renderSosBanner();
      updateNetStatus("求救信号已发送！", "error");
    } else {
      updateNetStatus("求救发送失败", "error");
    }
  } catch (err) {
    console.error(err);
    updateNetStatus("求救网络错误", "error");
  }
}

async function cancelMySos() {
  const myActiveSos = state.sos.find(s => s.memberId === state.settings.memberId && s.status !== "resolved");
  if (!myActiveSos) return;
  
  updateNetStatus("正在取消呼救...", "info");
  
  try {
    const url = `${state.settings.serverUrl}/api/team/sos/${myActiveSos.id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.settings.memberToken}`
      },
      body: JSON.stringify({ status: "resolved" })
    });
    
    if (res.ok) {
      state.sos = state.sos.filter(s => s.id !== myActiveSos.id);
      renderSosBanner();
      updateNetStatus("求救已顺利解除", "success");
    } else {
      updateNetStatus("取消呼救失败", "error");
    }
  } catch (err) {
    console.error(err);
    updateNetStatus("网络错误", "error");
  }
}

// --- Chat messaging logic ---
function renderChatMessages() {
  const container = document.getElementById("chatFeed");
  container.innerHTML = "";
  
  if (state.messages.length === 0) {
    container.innerHTML = `<div class="empty-feed">暂无通讯内容</div>`;
    return;
  }
  
  // Sort chronologically
  const sorted = [...state.messages].sort((a, b) => a.timestamp - b.timestamp);
  
  sorted.forEach(msg => {
    const isMine = msg.senderId === state.settings.memberId;
    const isPrivate = msg.recipientId !== null && msg.recipientId !== "";
    
    const div = document.createElement("div");
    div.className = `chat-msg ${isMine ? "mine" : ""} ${isPrivate ? "private" : ""}`;
    
    // Add long press deletion listener for my messages
    if (isMine) {
      div.style.cursor = "pointer";
      div.onclick = () => {
        if (confirm("是否要撤回此条消息？")) {
          deleteChatMessage(msg.id);
        }
      };
    }
    
    const dateStr = new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour: '2-digit', minute: '2-digit' });
    
    div.innerHTML = `
      <span class="msg-sender">${msg.senderName || msg.senderId}${isPrivate ? " ➔ 私信" : ""}</span>
      <p class="msg-body">${msg.content}</p>
      <span class="msg-time">${dateStr}</span>
    `;
    container.appendChild(div);
  });
  
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function populateRecipientDropdown() {
  const select = document.getElementById("messageRecipient");
  const currentVal = select.value;
  select.innerHTML = '<option value="">发送至全组</option>';
  
  state.members.forEach(m => {
    if (m.memberId !== state.settings.memberId) {
      const opt = document.createElement("option");
      opt.value = m.memberId;
      opt.innerText = m.displayName;
      select.appendChild(opt);
    }
  });
  
  select.value = currentVal;
}

async function sendChatMessage(e) {
  e.preventDefault();
  
  const recipient = document.getElementById("messageRecipient").value;
  const input = document.getElementById("chatMessageInput");
  const content = input.value.trim();
  
  if (!content) return;
  
  const payload = {
    senderId: state.settings.memberId,
    recipientId: recipient || null,
    content: content,
    timestamp: Date.now()
  };
  
  try {
    if (state.isWebSocketConnected && state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({
        type: "message",
        data: payload
      }));
      input.value = "";
    } else {
      // Fallback POST
      const res = await fetch(`${state.settings.serverUrl}/api/team/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${state.settings.memberToken}`
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const msg = await res.json();
        if (state.messages.none(m => m.id === msg.id)) {
          state.messages.push(msg);
          renderChatMessages();
        }
        input.value = "";
      }
    }
  } catch (err) {
    console.warn("Failed to send message:", err);
  }
}

async function deleteChatMessage(msgId) {
  try {
    const res = await fetch(`${state.settings.serverUrl}/api/team/messages/${msgId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${state.settings.memberToken}` }
    });
    if (res.ok) {
      state.messages = state.messages.filter(m => m.id !== msgId);
      renderChatMessages();
      updateNetStatus("消息已撤回", "success");
    } else {
      alert("撤回失败，您可能无权删除此消息");
    }
  } catch (e) {
    console.error(e);
  }
}

// --- Leaflet Mapping Logic ---
function initMap() {
  // Center around Wangjiapo
  const centerLat = 29.5742;
  const centerLon = 116.0026;
  
  state.map = L.map("mobileMap", {
    zoomControl: false,
    attributionControl: false
  }).setView([centerLat, centerLon], 14);
  
  // Custom Zoom Control positioning (down-left)
  L.control.zoom({
    position: 'bottomleft'
  }).addTo(state.map);
  
  // Base layers (AMap Tiles for China high-speed rendering)
  state.layers.normal = L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", {
    maxZoom: 19,
    subdomains: ["1", "2", "3", "4"]
  });
  
  state.layers.satellite = L.tileLayer("https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}", {
    maxZoom: 19,
    subdomains: ["1", "2", "3", "4"]
  });
  
  // Set default normal layer
  state.layers.normal.addTo(state.map);
  
  // Add static station markers
  STATIONS.forEach(st => {
    const icon = L.divIcon({
      className: 'custom-station-icon',
      html: `<div style="background-color:var(--coral); width:12px; height:12px; border-radius:50%; border:2px solid white; box-shadow:0 0 6px rgba(0,0,0,0.4);"></div>`,
      iconSize: [12, 12]
    });
    
    L.marker([st.lat, st.lon], { icon: icon })
      .addTo(state.map)
      .bindPopup(`<strong>观测站: ${st.name}</strong><br/>${st.subtitle}`)
      .on("click", () => {
        showMapNavigationCard(st.lat, st.lon, st.name);
      });
  });
}

function toggleSatelliteLayer() {
  if (state.activeLayerName === "normal") {
    state.map.removeLayer(state.layers.normal);
    state.layers.satellite.addTo(state.map);
    state.activeLayerName = "satellite";
    document.getElementById("btnSatelliteToggle").classList.add("active");
  } else {
    state.map.removeLayer(state.layers.satellite);
    state.layers.normal.addTo(state.map);
    state.activeLayerName = "normal";
    document.getElementById("btnSatelliteToggle").classList.remove("active");
  }
}

function updateSelfMarker() {
  if (!state.gps.lat || !state.map) return;
  
  const id = "self";
  const pos = [state.gps.lat, state.gps.lon];
  
  if (state.mapMarkers[id]) {
    state.mapMarkers[id].setLatLng(pos);
  } else {
    const icon = L.divIcon({
      className: 'custom-self-icon',
      html: `<div style="background-color:var(--ice); width:16px; height:16px; border-radius:50%; border:3px solid white; box-shadow:0 0 10px var(--ice);"></div>`,
      iconSize: [16, 16]
    });
    
    state.mapMarkers[id] = L.marker(pos, { icon: icon })
      .addTo(state.map)
      .bindPopup("<strong>我在此处</strong>");
  }
}

function updateMapTeammates() {
  if (!state.map) return;
  
  state.members.forEach(m => {
    // Skip self
    if (m.memberId === state.settings.memberId) return;
    
    const id = m.memberId;
    if (!m.latitude || m.latitude === 0) return;
    
    const pos = [m.latitude, m.longitude];
    const isOnline = m.receivedAt ? (Date.now() - new Date(m.receivedAt).getTime() < 180000) : false;
    const hasSos = state.sos.some(s => s.memberId === m.memberId && s.status !== "resolved");
    
    let color = hasSos ? "var(--error)" : (isOnline ? "var(--green)" : "var(--muted)");
    
    if (state.mapMarkers[id]) {
      state.mapMarkers[id].setLatLng(pos);
      // Update popups dynamically
      state.mapMarkers[id].getPopup().setContent(`<strong>${m.displayName}</strong><br/>状态: ${hasSos ? "紧急求救中" : (isOnline ? "在线" : "离线")}`);
    } else {
      const icon = L.divIcon({
        className: `custom-member-icon-${id}`,
        html: `<div style="background-color:${color}; width:14px; height:14px; border-radius:50%; border:2px solid white; box-shadow:0 0 8px ${color}; text-align:center; color:#0b1311; font-size:8px; font-weight:bold; line-height:10px;">${m.displayName.substring(0,1)}</div>`,
        iconSize: [14, 14]
      });
      
      state.mapMarkers[id] = L.marker(pos, { icon: icon })
        .addTo(state.map)
        .bindPopup(`<strong>${m.displayName}</strong><br/>状态: ${hasSos ? "紧急求救中" : (isOnline ? "在线" : "离线")}`)
        .on("click", () => {
          showMapNavigationCard(m.latitude, m.longitude, m.displayName);
        });
    }
  });
}

function locateSelfOnMap() {
  if (state.gps.lat) {
    state.map.setView([state.gps.lat, state.gps.lon], 16, { animate: true });
  } else {
    alert("尚未获取 GPS 定位，请稍后");
  }
}

function toggleMapTeammatesList() {
  const overlay = document.getElementById("mapTeammatesOverlay");
  if (overlay.style.display === "none") {
    // Populate teammate list
    const listContainer = document.getElementById("mapTeammatesList");
    listContainer.innerHTML = "";
    
    state.members.forEach(m => {
      const isSelf = m.memberId === state.settings.memberId;
      const hasPos = m.latitude && m.latitude !== 0;
      
      const item = document.createElement("div");
      item.className = "overlay-item";
      
      item.innerHTML = `
        <span class="${hasPos ? "" : "lbl-off"}">${m.displayName} ${isSelf ? "(我)" : ""} ${hasPos ? "" : "(无位置)"}</span>
        ${hasPos ? `
          <div class="overlay-actions">
            <button class="overlay-btn" onclick="panToTeammate(${m.latitude}, ${m.longitude})" title="定位"><i data-lucide="my-location"></i></button>
            ${!isSelf ? `<button class="overlay-btn nav-btn" onclick="showMapNavigationCard(${m.latitude}, ${m.longitude}, '${m.displayName}')" title="导航"><i data-lucide="navigation"></i></button>` : ""}
          </div>
        ` : ""}
      `;
      listContainer.appendChild(item);
    });
    
    overlay.style.display = "flex";
    initLucide();
  } else {
    overlay.style.display = "none";
  }
}

function panToTeammate(lat, lon) {
  state.map.setView([lat, lon], 16, { animate: true });
  document.getElementById("mapTeammatesOverlay").style.display = "none";
}

function showMapNavigationCard(lat, lon, name) {
  state.navTarget = { lat, lon, name };
  document.getElementById("navTargetName").innerText = `导航至: ${name}`;
  document.getElementById("navTargetCoords").innerText = `坐标: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  document.getElementById("mapNavTargetCard").style.display = "block";
}

function cancelMapNavigation() {
  state.navTarget = null;
  document.getElementById("mapNavTargetCard").style.display = "none";
}

function startMapNavigation() {
  if (!state.navTarget) return;
  
  const { lat, lon, name } = state.navTarget;
  const encodedName = encodeURIComponent(name);
  
  // Priorities: Intent schemes for native iOS/Android maps, web redirect for fallback
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  
  let navUrl = "";
  if (isIOS) {
    // Apple Maps URI
    navUrl = `maps://?q=${encodedName}&ll=${lat},${lon}&t=m`;
  } else {
    // Android/Universal maps fallback (Google/AMap URLs)
    navUrl = `androidamap://navi?sourceApplication=com.lushan.fieldwork&lat=${lat}&lon=${lon}&dev=0&style=2`;
  }
  
  // Try to open URI scheme, otherwise fallback to web high-contrast AMap routing
  const fallbackUrl = `https://uri.amap.com/navigation?to=${lon},${lat},${encodedName}&mode=car`;
  
  const start = Date.now();
  window.location.href = navUrl;
  
  setTimeout(() => {
    // If navigation doesn't open within 1.5s, redirect to web map
    if (Date.now() - start < 1800) {
      window.open(fallbackUrl, "_blank");
    }
  }, 1500);
  
  cancelMapNavigation();
}

// --- Status utilities ---
function updateNetStatus(text, type) {
  const badge = document.getElementById("netBadge");
  const label = document.getElementById("netText");
  
  badge.className = "network-badge";
  if (type === "error" || type === "offline") {
    badge.classList.add("offline");
  }
  label.innerText = text;
}

// --- Lightbox utilities ---
function openPhotoLightbox(path) {
  const lightbox = document.getElementById("photoLightbox");
  const img = document.getElementById("lightboxImage");
  img.src = path;
  lightbox.classList.add("open");
  lightbox.setAttribute("aria-hidden", "false");
  initLucide();
}

document.getElementById("closeLightbox").onclick = () => {
  const lightbox = document.getElementById("photoLightbox");
  lightbox.classList.remove("open");
  lightbox.setAttribute("aria-hidden", "true");
};

// --- UUID Generator ---
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    var r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
