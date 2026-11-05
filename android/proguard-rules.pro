# SuperBox R8 rules (SDK-only build, no Gradle)
-keep class com.superbox.mobile.MainActivity { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface,*Annotation*,Signature,InnerClasses,EnclosingMethod
-keep class org.json.** { *; }
-dontwarn **
-repackageclasses 'x'
-allowaccessmodification
