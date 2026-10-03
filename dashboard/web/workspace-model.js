export const STORAGE_KEY='lapis.workspace.v1';
export const SERVICES=[
  {id:'drive',name:'Google Drive',short:'Drive',icon:'△',color:'drive',description:'문서와 파일을 한곳에',url:'https://drive.google.com/',future:'최근 파일 · 공유 문서 · 폴더'},
  {id:'sheets',name:'Google Sheets',short:'시트',icon:'▦',color:'sheets',description:'업무 현황과 숫자 정리',url:'https://docs.google.com/spreadsheets/',future:'스프레드시트 · 표 · 업무 현황'},
  {id:'forms',name:'Google Forms',short:'설문',icon:'▤',color:'forms',description:'신청과 의견을 간편하게',url:'https://docs.google.com/forms/',future:'내 설문 · 응답 수 · 접수 내역'},
  {id:'gmail',name:'Gmail',short:'메일',icon:'M',color:'gmail',description:'받은 메일과 업무 연락',url:'https://mail.google.com/',future:'받은편지함 · 읽지 않은 메일'},
  {id:'youtube',name:'YouTube',short:'영상',icon:'▶',color:'youtube',description:'업무에 필요한 영상 자료',url:'https://www.youtube.com/',future:'내 재생목록 · 저장한 영상'},
];
export const TEMPLATES=[
  {id:'intake',title:'신청·설문 접수',category:'고객 · 신청',icon:'▤',description:'신청서를 받고, 응답을 정리하고, 안내까지.',steps:[
    {title:'신청서 준비',detail:'Google Forms에서 질문과 접수 기간을 확인하세요.',href:'https://docs.google.com/forms/',action:'Forms 열기'},
    {title:'응답 시트 정리',detail:'설문 응답을 연결한 시트에서 접수 내용을 확인하세요.',href:'https://docs.google.com/spreadsheets/',action:'Sheets 열기'},
    {title:'안내 메일 확인',detail:'대상과 안내 내용을 검토한 뒤 Gmail에서 직접 보내세요.',href:'https://mail.google.com/',action:'Gmail 열기'}]},
  {id:'report',title:'주간 업무 보고',category:'오피스 · 보고',icon:'▦',description:'팀 현황부터 자료 정리, 보고 초안까지.',steps:[
    {title:'팀 업무 확인',detail:'카오 오피스 현황판에서 이번 주 진행 상황을 확인하세요.',href:'#board',action:'현황판 보기'},
    {title:'보고 자료 모으기',detail:'Drive에서 필요한 문서와 시트를 찾고 자료 모음에 저장하세요.',href:'https://drive.google.com/',action:'Drive 열기'},
    {title:'보고 초안 작성',detail:'정리한 내용을 라피스 대화에 입력해 보고 초안을 요청하세요.',href:'#chat',action:'라피스에게 요청하기'}]},
  {id:'rental',title:'물품 대여 점검',category:'카오 · 물품관리',icon:'▣',description:'대여 내역과 재고, 후속 조치를 차례로 확인.',steps:[
    {title:'진행 중인 대여 확인',detail:'카오 물품관리 화면에서 대여와 반납 상태를 확인하세요.',href:'#rental',action:'물품 관리 열기'},
    {title:'재고·사진 확인',detail:'같은 화면의 물품목록과 사진 메뉴에서 실제 상태를 확인하세요.',href:'#rental',action:'물품 관리 열기'},
    {title:'담당 업무 정리',detail:'필요한 후속 조치를 카오 오피스에서 확인하고 정리하세요.',href:'#board',action:'카오 현황판 보기'}]},
  {id:'video',title:'영상 자료 정리',category:'자료 · 학습',icon:'▶',description:'찾은 영상을 저장하고, 업무 메모로 남기기.',steps:[
    {title:'영상 찾아보기',detail:'YouTube에서 업무에 필요한 영상이나 재생목록을 찾으세요.',href:'https://www.youtube.com/',action:'YouTube 열기'},
    {title:'영상 링크 저장',detail:'자료 모음에 영상 제목과 링크를 저장하세요.',href:'#library',action:'자료 모음 열기'},
    {title:'핵심 내용 정리',detail:'홈의 빠른 메모에 기억할 내용과 다음 행동을 적으세요.',href:'#home',action:'메모하러 가기'}]},
];
export function validateLink(value){
  let url;try{url=new URL(String(value).trim());}catch{throw new Error('올바른 링크를 입력해 주세요.');}
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('HTTPS Google 또는 YouTube 링크를 입력해 주세요.');
  const host=url.hostname;
  let service=host==='drive.google.com'?'drive':host==='mail.google.com'?'gmail':['www.youtube.com','youtube.com','m.youtube.com','youtu.be'].includes(host)?'youtube':host==='forms.gle'?'forms':null;
  if(host==='docs.google.com')service=url.pathname.startsWith('/spreadsheets')?'sheets':url.pathname.startsWith('/forms')?'forms':'drive';
  if(!service)throw new Error('Drive, Sheets, Forms, Gmail, YouTube 링크만 저장할 수 있습니다.');
  return {url:url.href,service};
}
export function progress(flow){
  const template=TEMPLATES.find(t=>t.id===flow.template);
  if(!template)return 0;
  return Math.round(new Set((flow.completed||[]).filter(i=>Number.isInteger(i)&&i>=0&&i<template.steps.length)).size/template.steps.length*100);
}
const blank=()=>({version:1,tasks:[],resources:[],flows:[],note:''});
function validate(value){
  if(!value||value.version!==1||!['tasks','resources','flows'].every(k=>Array.isArray(value[k])&&value[k].length<=200)||typeof value.note!=='string'||value.note.length>4000)throw new Error('저장된 업무 형식을 읽을 수 없습니다.');
  for(const key of ['tasks','resources','flows']){
    const ids=new Set();
    for(const item of value[key]){
      if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.title!=='string'||!item.title.trim()||item.title.length>160)throw new Error('업무 이름이나 식별자를 확인해 주세요.');
      ids.add(item.id);
      if(key==='tasks'&&typeof item.done!=='boolean')throw new Error('할 일 상태가 올바르지 않습니다.');
      if(key==='resources')validateLink(item.url);
      if(key==='flows'&&(!TEMPLATES.some(t=>t.id===item.template)||!Array.isArray(item.completed)||!item.completed.every(i=>Number.isInteger(i)&&i>=0&&i<TEMPLATES.find(t=>t.id===item.template).steps.length)))throw new Error('업무 단계가 올바르지 않습니다.');
    }
  }
  return structuredClone(value);
}
export function createWorkspaceStore(storage){
  let value=blank(),error=null,savedRaw=null;
  try{savedRaw=storage.getItem(STORAGE_KEY);if(savedRaw!==null)value=validate(JSON.parse(savedRaw));}catch{error='저장한 업무를 읽지 못했습니다. 원본을 보호하기 위해 저장을 중지했습니다. 브라우저 저장소 설정을 확인해 주세요.';}
  return {get value(){return structuredClone(value);},get error(){return error;},save(next){
    if(error)throw new Error(error);
    const validated=validate(next);
    let currentRaw;try{currentRaw=storage.getItem(STORAGE_KEY);}catch{throw new Error('브라우저 저장 상태를 확인하지 못했습니다. 저장하지 않았습니다.');}
    if(currentRaw!==savedRaw){
      try{value=currentRaw===null?blank():validate(JSON.parse(currentRaw));savedRaw=currentRaw;}catch{error='다른 탭의 저장 내용을 읽지 못했습니다. 원본을 보호하기 위해 저장을 중지했습니다.';throw new Error(error);}
      throw new Error('다른 탭에서 업무를 변경했습니다. 최신 내용을 불러왔으니 확인 후 다시 저장해 주세요.');
    }
    const serialized=JSON.stringify(validated);
    try{storage.setItem(STORAGE_KEY,serialized);}catch{throw new Error('브라우저에 저장하지 못했습니다. 저장 공간과 개인정보 설정을 확인해 주세요.');}
    savedRaw=serialized;
    value=validated;return structuredClone(value);
  }};
}
