; Shared by standard, signed-release and internal Windows packages.
; Keep the native MUI window and progress; installation artwork is static.
!include nsDialogs.nsh
!include FileFunc.nsh
SetFont "Microsoft YaHei UI" 10

!ifndef WANX_BUILD_LABEL
  !define WANX_BUILD_LABEL "${VERSION}"
!endif

!define MUI_BGCOLOR "FCF9F5"
!define MUI_TEXTCOLOR "302C28"
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!define MUI_INSTFILESPAGE_COLORS "715A45 FCF9F5"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "记忆盒子已准备就绪。$\r$\n$\r$\n开始整理记忆与资料，连接你的 AI。"
!define MUI_FINISHPAGE_RUN_TEXT "打开记忆盒子"
!define MUI_FINISHPAGE_BUTTON "完成"
!define MUI_CUSTOMFUNCTION_GUIINIT WanxInstallerGuiInit

Var wxWelcomeDialog
Var wxArtwork
Var wxBitmap
Var wxTitleFont
Var wxBodyFont
Var wxMetaFont
Var wxPathValue
Var wxDirectoryChanged

!macro customWelcomePage
  Page custom WanxWelcomePage WanxWelcomeLeave
!macroend

; electron-builder inserts this after MUI declares its control variables.
!macro customHeader
BrandingText " "
; Start with details collapsed, while keeping the native details button usable.
ShowInstDetails hide

Function WanxInstallerGuiInit
  CreateFont $wxTitleFont "Microsoft YaHei UI" 16 600
  CreateFont $wxBodyFont "Microsoft YaHei UI" 10 400
  CreateFont $wxMetaFont "Microsoft YaHei UI" 9 400
  SendMessage $HWNDPARENT ${WM_SETFONT} $wxBodyFont 1
FunctionEnd

Function WanxWelcomePage
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "准备安装" "半人马AI记忆盒子"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=memobox-windows-mark.bmp "${PROJECT_DIR}\resources\installer\redesign\windows-mark.bmp"

  nsDialogs::Create 1044
  Pop $wxWelcomeDialog
  ${If} $wxWelcomeDialog == error
    MessageBox MB_ICONSTOP|MB_OK "安装界面未能打开，请重新运行安装程序。"
    SetErrorLevel 1603
    Quit
  ${EndIf}
  SetCtlColors $wxWelcomeDialog 302C28 FCF9F5
  StrCpy $wxDirectoryChanged 0
  StrCpy $wxBitmap 0

  ${NSD_CreateBitmap} 8% 8% 18% 28% ""
  Pop $wxArtwork
  ${NSD_AddStyle} $wxArtwork ${SS_REALSIZECONTROL}
  ; Match height to the DPI-scaled width instead of stretching the square mark.
  System::Call '*(i 0, i 0, i 0, i 0) p.r0'
  System::Call 'user32::GetClientRect(p $wxArtwork, p r0)'
  System::Call '*$0(i, i, i.r1, i.r2)'
  System::Free $0
  System::Call 'user32::SetWindowPos(p $wxArtwork, p 0, i 0, i 0, i r1, i r1, i 0x16)'
  ${NSD_SetStretchedImage} $wxArtwork "$PLUGINSDIR\memobox-windows-mark.bmp" $wxBitmap

  ${NSD_CreateLabel} 30% 7% 64% 17% "让每次协作，都有记忆"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $wxTitleFont 1
  SetCtlColors $0 302C28 FCF9F5
  ${NSD_CreateLabel} 30% 26% 64% 18% "整理记忆与资料，连接你的 AI。"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $wxBodyFont 1
  SetCtlColors $0 756B61 FCF9F5

  ${NSD_CreateLabel} 8% 50% 84% 8% "安装位置"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $wxBodyFont 1
  SetCtlColors $0 302C28 FCF9F5
  ${NSD_CreateText} 8% 60% 66% 14% "$INSTDIR"
  Pop $wxPathValue
  SendMessage $wxPathValue ${WM_SETFONT} $wxBodyFont 1
  SendMessage $wxPathValue ${EM_SETREADONLY} 1 0
  SetCtlColors $wxPathValue 302C28 FFFFFF
  ${NSD_CreateButton} 76% 60% 16% 14% "更改"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $wxBodyFont 1
  ${NSD_OnClick} $0 WanxChooseInstallFolder

  ${NSD_CreateLabel} 8% 81% 84% 9% "升级安装会保留现有账号与资料。"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $wxMetaFont 1
  SetCtlColors $0 756B61 FCF9F5
  ${NSD_CreateLabel} 8% 91% 84% 9% "版本 ${WANX_BUILD_LABEL} · 当前用户"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $wxMetaFont 1
  SetCtlColors $0 756B61 FCF9F5
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_SetText} $0 "开始安装"

  nsDialogs::Show
  ; Show also returns on Cancel; always release the page bitmap.
  Call WanxWelcomeCleanup
FunctionEnd

Function WanxChooseInstallFolder
  Pop $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 == error
  ${OrIf} $0 == ""
    Return
  ${EndIf}
  StrCpy $INSTDIR "$0"
  StrCpy $wxDirectoryChanged 1
  Call WanxNormalizeInstallFolder
  ${NSD_SetText} $wxPathValue "$INSTDIR"
FunctionEnd

Function WanxNormalizeInstallFolder
  Push $0
  ; The former standard directory page added the application subdirectory.
  ; Do the same only for a folder explicitly selected in this page.
  GetFullPathName $INSTDIR "$INSTDIR"
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
  GetFullPathName $INSTDIR "$INSTDIR"
  Pop $0
FunctionEnd

Function WanxWelcomeLeave
  ; Preserve discovered upgrade paths and explicit /D paths when unchanged.
  ${If} $wxDirectoryChanged == 1
    Call WanxNormalizeInstallFolder
  ${EndIf}
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${WANX_MAX_INSTALL_DIR_LENGTH}
    MessageBox MB_ICONEXCLAMATION|MB_OK "安装位置过长，请选择更短的文件夹（最多 ${WANX_MAX_INSTALL_DIR_LENGTH} 个字符）。"
    Abort
  ${EndIf}
  Call WanxWelcomeCleanup
FunctionEnd

Function WanxWelcomeCleanup
  ${If} $wxBitmap != 0
    ${NSD_ClearImage} $wxArtwork
    ${NSD_FreeImage} $wxBitmap
    StrCpy $wxBitmap 0
  ${EndIf}
FunctionEnd

Function WanxInstallShow
  ; NSIS owns the real file-copy progress and its native details panel.
  !insertmacro MUI_HEADER_TEXT "正在安装" "正在复制应用与配套组件，请稍候。"
FunctionEnd
!macroend
