# ONE LINK

**테스트 중 · 0.1.3-beta.1 · 정식 출시 전**

기존 Tailscale 네트워크에서 기기를 연결해 파일·폴더를 공유하는 데스크톱 앱입니다. ONE LINK 회원가입이나 별도 운영 서버 없이 사용합니다.

**[Windows 테스트 버전 다운로드](https://github.com/VULCAN-HUB/OneLink/releases/tag/v0.1.3-beta.1)** · **[테스트 사용 안내](DEVICE-TEST.md)**

제작: **Unknown** · [홈페이지](https://vulcan-hub.github.io/) · [YouTube](https://www.youtube.com/@unknown8563)

## 기능

- 최초 승인 후 기기 연결 정보 보존, 파일·폴더 보내기.
- 여러 기기로 전송, 중단 후 재개, 파일 해시 검증.
- 허용한 기기에서 읽기 전용 공유 폴더 탐색·가져오기.
- 앱 안에서 beta 업데이트 확인·다운로드·재시작 적용.

## 요구사항과 상태

Windows x64, 기존 Tailscale 연결, NTFS 수신 저장소를 기준으로 테스트했습니다. Windows 설치형을 제공하며 macOS는 개발 중입니다.

로컬 자동 검사와 두 앱 사이의 파일 전송을 확인했습니다. 실제 다중 PC 네트워크, macOS, 대용량·장시간 사용과 버전 간 업데이트 설치는 추가 검증이 필요합니다. 자세한 제한은 [테스트 안내](DEVICE-TEST.md)를 확인하세요.

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
