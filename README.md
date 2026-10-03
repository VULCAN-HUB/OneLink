# ONE LINK

**테스트 중 · v0.1.3-beta.1 · 정식 출시 전**

기존 Tailscale 네트워크에 연결된 기기 사이에서 파일·폴더를 공유하는 데스크톱 앱입니다. ONE LINK 회원가입이나 별도 운영 서버 없이 사용합니다.

**[다운로드](https://github.com/VULCAN-HUB/OneLink/releases/tag/v0.1.3-beta.1)** · **[사용 안내](DEVICE-TEST.md)**

제작: **Unknown** · [홈페이지](https://vulcan-hub.github.io/) · [YouTube](https://www.youtube.com/@unknown8563)

## 기능

- 최초 승인 후 기기 연결 정보를 보존하고 파일·폴더를 보냅니다.
- 여러 기기로 전송하고, 중단 후 재개와 파일 해시 검증을 지원합니다.
- 허용한 기기의 읽기 전용 공유 폴더에서 자료를 가져옵니다.
- 앱 안에서 베타 업데이트를 확인·다운로드·적용합니다.

## 요구사항과 상태

| 항목 | 내용 |
|---|---|
| 실행 환경 | Windows x64 · 기존 Tailscale 연결 · NTFS 수신 저장소 |
| 배포 형태 | Windows 설치형 · macOS 개발 중 |

로컬 자동 검사와 두 앱 사이의 파일 전송을 확인했습니다. 실제 다중 PC 네트워크, macOS, 대용량·장시간 사용과 버전 간 업데이트 설치는 추가 검증이 필요합니다.

## 사용법

1. 기존 Tailscale 연결과 수신 저장소를 확인합니다.
2. Windows 설치형을 설치하고 기기를 승인합니다.
3. 파일·폴더를 보내거나 허용된 공유 폴더에서 자료를 가져옵니다.

[테스트 사용 안내](DEVICE-TEST.md)에서 제한과 점검 절차를 확인하세요.

## 개발과 빌드

Node.js 24 및 Windows 환경:

```sh
npm ci
npm test
npm run test:ui
node tests/updater-download.cjs
npm start
npm run dist:win
```

빌드 결과는 저장소 밖 ../build/, 테스트 데이터는 ../work/에 생성됩니다. 빌드 명령은 GitHub에 자동 게시하지 않습니다. 업데이트 파일은 이 저장소의 Releases에서 제공하며 앱에 GitHub 토큰을 포함하지 않습니다.

## 라이선스·공개 정책

프로젝트는 현재 오픈소스 라이선스를 부여하지 않았습니다. [LICENSE](LICENSE)와 [외부 구성요소 고지](THIRD_PARTY_NOTICES.txt)를 확인하세요. 포함 글꼴의 OFL 사본은 assets/fonts/에 있습니다.

[공개 정책](PUBLICATION_POLICY.md) · [자동화 규칙](AI_AUTOMATION_RULES.md) · [게시 전 체크리스트](PUBLICATION_CHECKLIST.md)

[공개 정책: VULCAN-0.3](https://github.com/VULCAN-HUB/RawBaker/blob/main/PUBLICATION_POLICY.md)
