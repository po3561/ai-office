// 한국에서 많이 쓰는 메일 서비스의 IMAP/SMTP 주소. 화면의 「계정 연결」이 이 목록을 보여 준다.
// note 는 사용자가 꼭 해야 하는 준비(앱 비밀번호, IMAP 켜기)를 알려 준다.
export const PRESETS={
  naver:{label:'네이버 메일',domains:['naver.com'],imap:{host:'imap.naver.com',port:993,secure:true},smtp:{host:'smtp.naver.com',port:465,secure:true},
    note:'네이버 메일 → 환경설정 → POP3/IMAP 설정에서 「IMAP/SMTP 사용」을 켜 주세요. 2단계 인증을 쓰면 「애플리케이션 비밀번호」를 만들어 넣어야 해요.',saveSent:true},
  daum:{label:'다음 · 한메일',domains:['daum.net','hanmail.net'],imap:{host:'imap.daum.net',port:993,secure:true},smtp:{host:'smtp.daum.net',port:465,secure:true},
    note:'다음 메일 → 환경설정 → IMAP/POP3 에서 IMAP 을 켜 주세요. 2단계 인증을 쓰면 카카오 계정의 「앱 비밀번호」가 필요해요.',saveSent:true},
  kakao:{label:'카카오 메일',domains:['kakao.com'],imap:{host:'imap.kakao.com',port:993,secure:true},smtp:{host:'smtp.kakao.com',port:465,secure:true},
    note:'카카오 메일 → 환경설정 → IMAP/POP3 에서 IMAP 을 켜고, 카카오 계정 보안에서 「앱 비밀번호」를 만들어 넣어 주세요.',saveSent:true},
  gmail:{label:'Gmail',domains:['gmail.com','googlemail.com'],imap:{host:'imap.gmail.com',port:993,secure:true},smtp:{host:'smtp.gmail.com',port:465,secure:true},
    note:'Google 계정 → 보안 → 2단계 인증을 켠 뒤 「앱 비밀번호」(16자리)를 만들어 넣어 주세요. 평소 비밀번호로는 연결되지 않아요.',saveSent:false},
  nate:{label:'네이트 메일',domains:['nate.com'],imap:{host:'imap.nate.com',port:993,secure:true},smtp:{host:'smtp.mail.nate.com',port:465,secure:true},
    note:'네이트 메일 환경설정에서 IMAP 사용을 켜 주세요.',saveSent:true},
  daou:{label:'다우오피스·회사 메일',domains:[],imap:{host:'',port:993,secure:true},smtp:{host:'',port:465,secure:true},
    note:'회사 메일 관리자에게 IMAP/SMTP 서버 주소를 받아 넣어 주세요(다우오피스는 보통 mail.회사도메인).',saveSent:true},
  outlook:{label:'Outlook · Microsoft 365',domains:['outlook.com','hotmail.com','live.com','msn.com'],imap:{host:'outlook.office365.com',port:993,secure:true},smtp:{host:'smtp.office365.com',port:587,secure:false},
    note:'Microsoft 계정은 비밀번호 대신 Microsoft 로그인 창에서 승인해 연결해요.',oauth:'microsoft',saveSent:false},
  custom:{label:'직접 입력',domains:[],imap:{host:'',port:993,secure:true},smtp:{host:'',port:465,secure:true},note:'메일 서비스가 알려 준 IMAP/SMTP 주소와 포트를 넣어 주세요.',saveSent:true},
};
export function presetFor(address){
  const domain=String(address||'').split('@')[1]?.toLowerCase()||'';
  for(const [id,p] of Object.entries(PRESETS))if(p.domains.includes(domain))return id;
  return 'custom';
}
export const publicPresets=()=>Object.entries(PRESETS).map(([id,p])=>({id,label:p.label,domains:p.domains,imap:p.imap,smtp:p.smtp,note:p.note,oauth:p.oauth||null}));
