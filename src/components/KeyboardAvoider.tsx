import React from 'react';
import { KeyboardAvoidingView, Platform, View, ViewProps } from 'react-native';

import { useKeyboardOffset } from '../hooks/useKeyboardOffset';

/**
 * Drop-in replacement for KeyboardAvoidingView. iOS has a real native
 * keyboard observer (RCTKeyboardObserver) so the stock component works
 * fine there. Android goes through useKeyboardOffset instead — see that
 * file for why the stock component under-compensates on this SDK.
 */
export function KeyboardAvoider({ style, children, ...rest }: ViewProps) {
  if (Platform.OS === 'ios') {
    return (
      <KeyboardAvoidingView style={style} behavior="padding" {...rest}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  return (
    <AndroidKeyboardAvoider style={style} {...rest}>
      {children}
    </AndroidKeyboardAvoider>
  );
}

function AndroidKeyboardAvoider({ style, children, ...rest }: ViewProps) {
  const keyboardOffset = useKeyboardOffset();
  return (
    <View style={[style, { paddingBottom: keyboardOffset }]} {...rest}>
      {children}
    </View>
  );
}
