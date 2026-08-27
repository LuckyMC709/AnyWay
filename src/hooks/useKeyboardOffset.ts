import { useEffect, useState } from 'react';
import { Keyboard, KeyboardEvent, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * How much to pad the bottom of the screen while the keyboard is up, on
 * Android specifically.
 *
 * This SDK/RN version force-enables edge-to-edge on Android 15+ (see
 * WindowUtil.kt / EdgeToEdgePackage.kt in react-native /
 * expo-modules-core — there's no app.json switch to opt out). Under
 * edge-to-edge the content area extends behind where the nav bar used to
 * reserve space, but ReactRootView's keyboard-height calculation still
 * does `imeInset.bottom - systemBarInset.bottom` (see
 * ReactRootView#checkForKeyboardEvents), which is the right math for the
 * old non-edge-to-edge layout, not this one — it under-reports the
 * keyboard height by roughly the nav bar's height. That's what made
 * `KeyboardAvoidingView` cover part of the input even with a `behavior`
 * set: the number it receives from RN core is already short by that
 * amount. This hook reads the same event and adds the nav bar inset back.
 */
export function useKeyboardOffset(): number {
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const onShow = (event: KeyboardEvent) => {
      const reported = event.endCoordinates?.height ?? 0;
      setKeyboardHeight(reported > 0 ? reported + insets.bottom : 0);
    };
    const onHide = () => setKeyboardHeight(0);

    const showSub = Keyboard.addListener('keyboardDidShow', onShow);
    const hideSub = Keyboard.addListener('keyboardDidHide', onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [insets.bottom]);

  return keyboardHeight;
}
