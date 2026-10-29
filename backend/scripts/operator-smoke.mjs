import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const origin = new URL(process.argv[2]);
if (origin.protocol !== "https:")
  throw new Error("A public HTTPS API origin is required");
origin.pathname = "/";
origin.search = "";
origin.hash = "";
const frontendOrigin = "https://dude759.github.io";
async function call(
  path,
  method = "GET",
  body,
  token,
  requestOrigin = frontendOrigin,
  extraHeaders = {},
) {
  const response = await fetch(new URL(path, origin), {
    method,
    signal: AbortSignal.timeout(90000),
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  return {
    status: response.status,
    data,
    cors: response.headers.get("access-control-allow-origin"),
  };
}
const assertions = [];
function pass(name) {
  assertions.push(name);
  console.log(JSON.stringify({ check: name, result: "PASS" }));
}
async function pause(phase, extra = {}) {
  console.log(JSON.stringify({ phase, ...extra }));
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  await new Promise((resolve) => input.once("line", resolve));
  input.close();
}
const op=(await call('/api/auth/login','POST',{email:'operator@energotransport.test',password:'Demo12345',role:'operator'})).data.token;
const driver=(await call('/api/auth/login','POST',{email:'driver@energotransport.test',password:'Demo12345',role:'driver'})).data.token;
const input={name:'Учебная QA Stage4A '+Date.now(),address:'Учебный объект, не реальная ЭЗС',district:'QA',coordinates:[37.61,55.76],maxPowerKw:100,limitKw:100,pricePerKwh:18};
const key=randomUUID();const s=await call('/api/operator/stations','POST',input,op,frontendOrigin,{'Idempotency-Key':key});assert.equal(s.status,201);assert.equal(s.data.status,'service');assert.equal((await call('/api/operator/stations','POST',input,op,frontendOrigin,{'Idempotency-Key':key})).data.id,s.data.id);
const path='/api/operator/stations/'+s.data.id;const ports=[];
for(const label of ['QA A','QA B']){const p=await call(path+'/connectors','POST',{label,type:'CCS2',maxPowerKw:22,status:'idle'},op,frontendOrigin,{'Idempotency-Key':randomUUID()});assert.equal(p.status,201);ports.push(p.data.id);}
assert.equal((await call(path,'PATCH',{status:'online'},op)).status,200);pass('Create service station, two physical ports, activation and idempotency');
const detail=(await call('/api/stations/'+s.data.id,'GET',undefined,driver)).data;assert.deepEqual(detail.coordinates,input.coordinates);assert.equal(detail.connectors[0].total,2);
assert.equal((await call(path,'PATCH',{pricePerKwh:20},op)).status,200);assert.equal((await call('/api/stations/'+s.data.id,'GET',undefined,driver)).data.pricePerKwh,20);pass('Driver catalog reflects database coordinates and permitted tariff update');
const start=new Date(Date.now()+300000).toISOString();const availability=await call('/api/stations/'+s.data.id+'/availability?'+new URLSearchParams({start,duration:'30',connector:'CCS2'}),'GET',undefined,driver);assert.equal(availability.data.available,2);
const payment=await call('/api/payments','POST',{input:{stationId:s.data.id,connector:'CCS2',start,duration:30,payment:'card'}},driver,frontendOrigin,{'Idempotency-Key':randomUUID()});assert.equal(payment.status,201);
const u=new URL(payment.data.confirmationUrl);const accepted=await fetch(new URL(u.pathname,origin),{method:'POST',headers:{Origin:origin.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:u.searchParams.get('token'),outcome:'succeeded'})});assert.equal(accepted.status,200);
const paid=(await call('/api/payments/'+payment.data.id,'GET',undefined,driver)).data;assert(paid.bookingId);assert.equal((await call(path+'/archive','POST',{},op)).status,409);pass('New physical port supports paid booking; live reservation blocks archive');
assert.equal((await call('/api/bookings/'+paid.bookingId+'/cancel','POST',{},driver)).status,200);const w=(await call('/api/workspace','GET',undefined,driver)).data;assert.equal(w.bookings.find(b=>b.id===paid.bookingId).refund.status,'succeeded');
for(const id of ports)assert.equal((await call('/api/operator/connectors/'+id+'/archive','POST',{},op)).status,200);
assert.equal((await call(path+'/archive','POST',{},op)).status,200);assert(!(await call('/api/stations?limit=200')).data.items.some(x=>x.id===s.data.id));assert.equal((await call('/api/stations/'+s.data.id,'GET',undefined,driver)).status,200);
const journal=(await call('/api/operator/events?limit=100','GET',undefined,op)).data.items.filter(e=>e.stationId===s.data.id);assert(journal.length>=8);assert(journal.every(e=>e.actorId));pass('Full test refund, archive, historical detail and actor audit');
await call('/api/auth/logout','POST',undefined,op);await call('/api/auth/logout','POST',undefined,driver);
console.log(JSON.stringify({result:'PASS',checks:assertions,stationId:s.data.id,bookingId:paid.bookingId,ports,archived:true}));

