# Global Trade Lens · 글로벌 무역 데이터 대시보드

미국 Census Bureau · EU Eurostat · 한국 관세청의 수출입 통계를 HS코드/NAICS 기준으로 시각화하고, DART 공시 기반 국내 주요 기업 실적을 오버레이하는 웹 대시보드.

## 주요 기능

- 🇺🇸 **미국 HS코드 수입** (Census Bureau)
- 🇪🇺 **유럽 HS코드 수입** (Eurostat)
- 🇰🇷 **국내 HS코드 수출입** (관세청 · 수출국·수입국별 분해)
- 📊 **NAICS 산업별 무역수지** 
- 🏭 **M3 제조업 지표** (신규주문·재고·출하·수주잔고)
- 📈 **기업 실적 오버레이** (SK하이닉스·삼성전자·아모레·삼양식품·농심·효성중공업·LS일렉트릭·한국콜마)

## 빠른 시작

### 1. 의존성

Node.js 18+ (npm install 불필요 — 기본 모듈만 사용)

### 2. 키 설정

```bash
cp config.example.json config.json
```

`config.json`의 각 키 값을 실제 발급받은 값으로 교체.

| 키 | 발급처 | 비고 |
|---|---|---|
| `kcs` | [공공데이터포털](https://www.data.go.kr/data/15100065/openapi.do) | 관세청 수출입무역통계 (품목별/국가별 공통) |
| `census` | [api.census.gov](https://api.census.gov/data/key_signup.html) | 이메일 인증 즉시 발급 |
| `dart` | [OpenDART](https://opendart.fss.or.kr/) | 일 10,000건 무료 |

### 3. 실행

```bash
node proxy.js
```

브라우저에서 `http://localhost:8787/` 접속.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 대시보드 UI (Chart.js · 단일 HTML) |
| `proxy.js` | 로컬 CORS 프록시 (Node 기본 모듈만) |
| `config.json` | 실제 API 키 (gitignored) |
| `config.example.json` | 키 템플릿 |

## 동작 모드

- **샘플 모드**: 프록시 미기동 시 내장된 샘플 데이터로 UI 동작
- **실데이터 모드**: 프록시 기동 후 각 뷰의 "실데이터 갱신" 버튼 클릭 시 실제 API 호출

## 데이터 공개 지연

- 🇺🇸 미국 Census: 최종 수출입 전월치를 **1~2개월 후** 공개
- 🇪🇺 Eurostat: **2~3개월** 후 공개
- 🇰🇷 관세청: 매월 15일경 **전월 확정치** 공개 (가장 빠름)

## 보안 주의

- `config.json` 은 절대 공개 저장소에 커밋하지 말 것 (.gitignore 등록됨)
- API 키가 노출되면 즉시 재발급
- 기본 프록시는 `127.0.0.1` 로컬 바인딩으로 외부 접근 차단

## 라이선스

개인 용도 / 투자 참조. 각 API의 이용약관 준수 필요.
