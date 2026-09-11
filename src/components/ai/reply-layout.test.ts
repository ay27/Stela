import assert from "node:assert/strict";
import { replyExecutionEntries, splitAgentReplies } from "./reply-layout";
import type { AgentTimelineEntry } from "@/state/agent-panel";
const entries: AgentTimelineEntry[] = [
  {kind:"tool",id:"q1",callId:"c1",name:"run_query",args:{query:"SELECT 1"},result:{ok:true,summary:"one"}},
  {kind:"progress",id:"p",runId:"r",stepIndex:1,content:"Checking another query",phase:"completed"},
  {kind:"tool",id:"q2",callId:"c2",name:"run_query",args:{query:"SELECT 2"},result:{ok:false,summary:"failed"}},
  {kind:"error",id:"error",message:"Connection unavailable"},
  {kind:"final",id:"final",runId:"r",content:"The first result is 1."},
];
assert.equal(splitAgentReplies(entries).length,1, "interleaved narration must not split execution details");
assert.deepEqual(replyExecutionEntries(entries).map(e=>e.id),["q1","p","q2"]);
const user: AgentTimelineEntry = {kind:"user",id:"u",message:{version:1,segments:[{kind:"text",text:"Next"}],resources:[]}};
assert.equal(splitAgentReplies([...entries,user,...entries]).length,2);
console.log("Reply layout: one disclosure per reply; conclusions and failures remain visible.");

const question: AgentTimelineEntry = {kind:"proposal",id:"question",runId:"r",callId:"ask",proposalKind:"question",payload:{description:"Which period?"},approvalMode:"manual",resolution:"pending"};
assert.equal(replyExecutionEntries([question]).length,0,"pending user decisions must never be hidden");
assert.equal(replyExecutionEntries([{...question,resolution:"approved"}]).length,1);
