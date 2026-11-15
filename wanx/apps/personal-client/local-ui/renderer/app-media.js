// Temporary, user-approved image assets only. This map never creates catalog entries
// or supplies names, descriptions, versions, installation or access permissions.
(() => {
  const media = Object.assign(Object.create(null), {
  "centaurai.wanx.semantica": {
    "icon": "assets/app-icons/xingtu-v1.png",
    "posters": [
      "xingtu-product-v1.png"
    ]
  },
  "centaurai.wanx.zhijun": {
    "icon": "assets/app-icons/zhijun-v1.png",
    "posters": [
      "zhijun-product-v1.png"
    ]
  },
  "centaurai.wanx.superadvisors": {
    "icon": "assets/app-icons/council-v1.png",
    "posters": [
      "council-product-v1.png"
    ]
  },
  "centaurai.wanx.dialogue": {
    "icon": "assets/app-icons/dialogue-v1.png",
    "posters": [
      "dialogue-product-v1.png"
    ]
  },
  "centaurai.wanx.centaurloop": {
    "icon": "assets/app-icons/loop-v1.png",
    "posters": [
      "loop-product-v1.png"
    ]
  },
  "centaurai.wanx.ai-browser": {
    "icon": "assets/app-icons/browser-v1.png",
    "posters": [
      "browser-product-v1.png"
    ]
  },
  "centaurai.media-express": {
    "icon": "assets/app-icons/publisher-v1.png",
    "posters": [
      "publisher-product-v1.png"
    ]
  }
});
  for (const item of Object.values(media)) { Object.freeze(item.posters); Object.freeze(item); }
  window.wanxAppMedia = Object.freeze(media);
})();
